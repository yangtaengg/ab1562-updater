import {concat, u16, u32, read16, read32, inspectDevice, validatePair, validateAppliedPair, validatePartialPair, parsePartitions, parseState, verifyFirmware} from './protocol.mjs';
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

export function crc8(data) {
  let c = 0;
  for (const byte of data) {
    c ^= byte;
    for (let bit = 0; bit < 8; bit++) c = ((c << 1) ^ (c & 0x80 ? 0x31 : 0)) & 255;
  }
  let reversed = 0;
  for (let bit = 0; bit < 8; bit++) { reversed = reversed << 1 | c & 1; c >>>= 1; }
  return reversed;
}
export function planFlash(bytes, partition) {
  const rounded = Math.ceil(bytes.length / 4096) * 4096;
  if (!bytes.length || rounded > partition.length || partition.address % 4096 || partition.length % 4096 ||
      partition.address + rounded > 0x100000000) throw new Error('펌웨어가 기기 파티션의 범위를 벗어납니다.');
  const erases = [], pages = [];
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    erases.push({address: partition.address + offset, length: Math.min(4096, bytes.length - offset)});
  }
  for (let offset = 0; offset < bytes.length; offset += 256) {
    const page = new Uint8Array(256).fill(255);
    page.set(bytes.subarray(offset, offset + 256));
    if (!page.every(b => b === 255)) pages.push({address: partition.address + offset, data: page, crc: crc8(page)});
  }
  pages.reverse();
  return {partition, rounded, erases, pages, bytes: bytes.length};
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const sameIdentity = (a, b) => ['company', 'module', 'version', 'channel'].every(k => a[k] === b[k]);
export class Updater {
  constructor(client, profile, {onProgress = () => {}, log = () => {}, sleep = wait} = {}) {
    this.client = client; this.profile = profile; this.onProgress = onProgress; this.log = log; this.sleep = sleep;
    this.stage = 'idle'; this.commitStarted = false; this.busy = false; this.touched = false;
  }
  progress(stage, percent, text) { this.stage = stage; this.onProgress({stage, percent, text}); }
  async command(id, payload, {route = 'local', type = 0x5d, match, timeout = 10000, retry = false, reclaim = false} = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        const p = await this.client.request(id, payload, {route, type, match, timeout});
        const status = p.body[0];
        if (reclaim) {
          if (!p.body.length || status === 0) throw new Error('NV 공간 준비 응답을 확인하지 못했습니다.');
        } else if (![0, 0xd0, 0xd1].includes(status)) {
          const error = new Error(`기기가 명령 0x${id.toString(16)}을 거절했습니다 (0x${Number(status).toString(16)}).`);
          error.deviceRejected = true; throw error;
        }
        if ([0xd0, 0xd1].includes(status)) await this.sleep(200);
        return p;
      } catch (e) {
        // Only address-scoped erase/program operations are replayed. Never replay commit or reclaim.
        if (!retry || attempt >= 2 || e.deviceRejected || !this.client.transport || this.client.transport.closed) throw e;
        this.log(`동일 주소 명령 재시도 ${attempt + 1}/2`); await this.sleep(200);
      }
    }
  }
  async start(previous, files, {confirmed = false, recovery = false} = {}) {
    if (!confirmed) throw new Error('업데이트 시작 확인이 필요합니다.');
    if (this.busy || this.touched) throw new Error('같은 작업에서 전송을 다시 시작할 수 없습니다. 상태를 새로 확인해 주세요.');
    this.busy = true;
    try {
      this.progress('check', 0, '양쪽 기기와 파일을 다시 검사하고 있습니다.');
      for (const side of ['left', 'right']) await verifyFirmware(files[side], this.profile.files[side]);
      const current = await inspectDevice(this.client);
      validatePair(current, this.profile, {allowRecovery: recovery});
      this.recovery = recovery;
      for (const route of ['local', 'peer']) {
        if (!sameIdentity(current[route], previous[route])) throw new Error('준비 후 기기 구성이 변경됐습니다. 다시 연결해 주세요.');
      }
      const plans = {};
      for (const route of ['local', 'peer']) {
        const p = current[route].partitions.find(p => p.id === 0 && p.recipient === 255);
        plans[route] = planFlash(files[current[route].channel], p);
      }
      this.before = current; this.files = files;
      await this.client.transport.authorize?.();
      this.client.writeEnabled = true;
      this.touched = true;
      // Original FlyCC's FOTA entry clears the same NV key on both devices.
      for (const route of ['local', 'peer']) {
        await this.command(0x0a03, [1, 0], {route, type: 0x5b, reclaim: true});
        await this.command(0x0a01, [0, 0x3a, 0], {route, type: 0x5b});
      }
      await this.client.destinations();
      await this.checkBattery('peer'); await this.command(0x0e01, [], {route: 'peer', type: 0x5b});
      await this.checkBattery('local'); await this.command(0x0e01, [], {type: 0x5b});
      this.completedWork = 0;
      this.totalWork = Object.values(plans).reduce((n, p) => n + p.erases.length + p.pages.length, 0);
      for (const route of ['local', 'peer']) {
        if (route === 'peer') await this.client.destinations();
        await this.client.transport.authorize?.();
        const device = current[route], file = files[device.channel], plan = plans[route];
        const side = device.channel === 'left' ? '왼쪽' : '오른쪽';
        let initialized = false;
        if (recovery && device.state === 0x0311) {
          const staged = await this.verifyStaged(device, file, plan);
          initialized = staged.initialized;
          if (staged.matched) {
            this.completedWork += plan.erases.length + plan.pages.length;
            this.progress('transfer', 5 + 85 * this.completedWork / this.totalWork, `${side}에 이미 전송된 파일이 일치합니다. 다시 쓰지 않습니다.`);
            continue;
          }
          if (staged.error) this.log(`${side} 전송본 확인 실패: ${staged.error.message}. 전체 전송으로 진행합니다.`);
        }
        await this.transferSide(device, file, plan, {initialized});
      }
      for (const route of ['local', 'peer']) {
        const state = parseState(await this.client.read(0x1c04, [1, 255], {route}));
        if (state !== 0x0311) throw new Error('양쪽 기기의 전송 완료 상태가 일치하지 않습니다. 적용을 중단했습니다.');
      }
      this.progress('apply', 92, '양쪽 전송을 확인했습니다. 배터리와 무결성을 다시 검사합니다.');
      await this.checkBattery('peer'); await this.checkBattery('local');
      await this.client.transport.authorize?.();
      for (const route of ['peer', 'local']) {
        await this.command(0x1c01, [1, 255, plans[route].partition.storage], {route, timeout: 30000});
      }
      this.commitStarted = true;
      this.progress('apply', 96, '펌웨어 적용을 요청합니다. 기기가 재시작할 수 있습니다.');
      await this.command(0x1c02, [1, 255], {route: 'peer', type: 0x5b, timeout: 15000});
      await this.command(0x1c02, [1, 255], {type: 0x5b, timeout: 15000});
      this.progress('reconnect', 98, '적용 요청을 마쳤습니다. 기기를 다시 연결해 양쪽 버전을 확인하세요.');
      return {status: 'awaiting-reconnect', before: this.before};
    } catch (error) {
      this.progress(this.commitStarted ? 'uncertain' : 'failed', 0,
        this.commitStarted ? '적용 응답이 불확실합니다. 다시 전송하지 말고 재연결 후 양쪽 버전을 확인하세요.' : error.message);
      if (this.touched && !this.commitStarted) await this.stopAfterFailure();
      throw error;
    } finally { this.busy = false; this.client.writeEnabled = false; await this.client.transport.revoke?.(); }
  }
  async checkBattery(route) {
    const p = await this.client.read(0x0cd6, [0], {route});
    if (p.body.length < 3 || p.body[0] !== 0 || p.body[2] < 60 || p.body[2] > 100) throw new Error('양쪽 배터리가 60% 이상이어야 합니다.');
  }
  async verifyStaged(device, bytes, plan) {
    const route = device.route, partition = plan.partition;
    let initialized = false;
    try {
      await this.command(0x1c08, [1, 255], {route});
      await this.command(0x1c0a, [1, 255], {route});
      initialized = true;
      await this.command(0x0430, [1, 255, partition.storage, 0], {route});
      await this.command(0x0433, concat([1, 255, partition.storage], u32(partition.address), u32(plan.rounded)), {route, timeout: 20000});
      const p = await this.command(0x0431, concat([1, 255, partition.storage], u32(partition.address), u32(bytes.length)), {route, timeout: 30000});
      if (p.body.length < 44 || p.body[1] !== 1 || p.body[2] !== 255 || p.body[3] !== partition.storage ||
          read32(p.body, 4) !== partition.address || read32(p.body, 8) !== bytes.length) throw new Error('비교 응답 형식이 다릅니다.');
      const actual = hex(p.body.subarray(12, 44));
      if (actual !== this.profile.files[device.channel].sha256) {
        this.log(`기기에 저장된 SHA-256이 배포 파일과 다릅니다: ${actual.slice(0, 16)}...`);
        return {matched: false, initialized};
      }
      await this.command(0x1c01, [1, 255, partition.storage], {route, timeout: 30000});
      await this.command(0x1c06, concat([1, 255], u16(0x0311)), {route});
      return {matched: true, initialized};
    } catch (error) {
      return {matched: false, initialized, error};
    }
  }
  async transferSide(device, bytes, plan, {initialized = false} = {}) {
    const route = device.route;
    const actual = parsePartitions(await this.client.read(0x1c00, [1, 255, 0], {route}));
    const partition = actual.find(p => p.recipient === 255 && p.id === 0);
    if (!partition || ['address', 'length', 'storage'].some(k => partition[k] !== plan.partition[k])) throw new Error('전송 직전 파티션 정보가 변경됐습니다.');
    if (!initialized) {
      await this.command(0x1c08, [1, 255], {route});
      await this.command(0x1c0a, [1, 255], {route});
    }
    // The staged side is compared first; an unverified side is erased and written in full.
    await this.command(0x0430, [1, 255, partition.storage, 0], {route});
    const side = device.channel === 'left' ? '왼쪽' : '오른쪽';
    let lastAuth = Date.now();
    const keepAuthorized = async () => {
      if (Date.now() - lastAuth < 4 * 60 * 1000) return;
      await this.client.transport.authorize?.();
      lastAuth = Date.now();
    };
    for (const block of plan.erases) {
      await keepAuthorized();
      await this.command(0x0404, concat([1, 255, partition.storage], u32(block.address), u32(block.length)),
        {route, retry: true, timeout: 15000, match: p => p.body.length >= 12 && p.body[2] === 255 && p.body[3] === partition.storage && read32(p.body, 4) === block.address && read32(p.body, 8) === block.length});
      this.completedWork++; this.progress('transfer', 5 + 85 * this.completedWork / this.totalWork, `${side} 저장 영역을 준비하고 있습니다.`);
    }
    for (const page of plan.pages) {
      await keepAuthorized();
      await this.command(0x0402, concat([partition.storage, 1, page.crc], u32(page.address), page.data),
        {route, type: 0x5b, retry: true, timeout: 12000, match: p => p.body.length === 7 && p.body[1] === partition.storage && p.body[2] === 1 && read32(p.body, 3) === page.address});
      this.completedWork++; this.progress('transfer', 5 + 85 * this.completedWork / this.totalWork, `${side} 펌웨어를 전송하고 있습니다.`);
    }
    await this.command(0x1c01, [1, 255, partition.storage], {route, timeout: 30000});
    await this.command(0x1c06, concat([1, 255], u16(0x0311)), {route});
  }
  async completeSingle(previous, files, {route, targetVersion, confirmed = false, recovery = false} = {}) {
    if (!confirmed) throw new Error('업데이트 시작 확인이 필요합니다.');
    if (this.busy || this.touched) throw new Error('같은 작업에서 전송을 다시 시작할 수 없습니다. 상태를 새로 확인해 주세요.');
    this.busy = true;
    try {
      this.progress('check', 0, '남은 한쪽 기기와 파일을 검사하고 있습니다.');
      for (const side of ['left', 'right']) await verifyFirmware(files[side], this.profile.files[side]);
      const current = await inspectDevice(this.client);
      const partial = validatePartialPair(current, this.profile, targetVersion);
      if (partial.old.route !== route) throw new Error('업데이트할 기기 경로가 바뀌었습니다. 다시 연결해 주세요.');
      if (!sameIdentity(current[route], previous[route])) throw new Error('준비 후 기기 구성이 변경됐습니다. 다시 연결해 주세요.');
      const plan = planFlash(files[current[route].channel], current[route].partitions.find(p => p.id === 0 && p.recipient === 255));
      this.before = current; this.files = files; this.targetVersion = targetVersion; this.singleRoute = route;
      await this.client.transport.authorize?.();
      this.client.writeEnabled = true; this.touched = true;
      // Only the old side is prepared.  The already-updated side keeps its 0101
      // post-apply state until both versions match.
      await this.command(0x0a03, [1, 0], {route, type: 0x5b, reclaim: true});
      await this.command(0x0a01, [0, 0x3a, 0], {route, type: 0x5b});
      await this.client.destinations();
      await this.checkBattery('local'); await this.checkBattery('peer');
      await this.command(0x0e01, [], {route, type: 0x5b});
      this.completedWork = 0; this.totalWork = plan.erases.length + plan.pages.length;
      let initialized = false;
      if (recovery && current[route].state === 0x0311) {
        const staged = await this.verifyStaged(current[route], files[current[route].channel], plan);
        initialized = staged.initialized;
        if (staged.matched) {
          this.completedWork = this.totalWork;
          this.progress('transfer', 90, '이미 전송된 파일이 일치합니다. 다시 쓰지 않습니다.');
        } else if (staged.error) this.log('전송본 확인 실패: ' + staged.error.message + '. 전체 전송으로 진행합니다.');
      }
      if (this.completedWork < this.totalWork) {
        await this.transferSide(current[route], files[current[route].channel], plan, {initialized});
      }
      const state = parseState(await this.client.read(0x1c04, [1, 255], {route}));
      if (state !== 0x0311) throw new Error('전송 완료 상태를 확인하지 못했습니다. 적용을 중단했습니다.');
      this.progress('apply', 92, '남은 한쪽 전송을 확인했습니다. 배터리와 무결성을 다시 검사합니다.');
      await this.checkBattery('local'); await this.checkBattery('peer');
      await this.client.transport.authorize?.();
      await this.command(0x1c01, [1, 255, plan.partition.storage], {route, timeout: 30000});
      this.commitStarted = true;
      this.progress('apply', 96, '남은 한쪽 기기에 적용을 요청합니다. 기기가 재시작할 수 있습니다.');
      await this.command(0x1c02, [1, 255], {route, type: 0x5b, timeout: 15000});
      this.progress('reconnect', 98, '적용 요청을 마쳤습니다. 기기를 다시 연결해 양쪽 버전을 확인하세요.');
      return {status:'awaiting-reconnect', before:this.before};
    } catch (error) {
      this.progress(this.commitStarted ? 'uncertain' : 'failed', 0,
        this.commitStarted ? '적용 응답이 불확실합니다. 다시 전송하지 말고 재연결 후 양쪽 버전을 확인하세요.' : error.message);
      if (this.touched && !this.commitStarted) await this.stopSingle();
      throw error;
    } finally { this.busy = false; this.client.writeEnabled = false; await this.client.transport.revoke?.(); }
  }
  async verifyPartialAfterReconnect() {
    if (!this.commitStarted || !this.before || !this.targetVersion) throw new Error('이 브라우저에서 적용한 전송 기록이 없습니다.');
    const after = await inspectDevice(this.client);
    for (const old of Object.values(this.before)) {
      const current = Object.values(after).find(d => d.channel === old.channel);
      if (!current || current.company !== old.company || current.module !== old.module) throw new Error('재연결한 기기의 제품이 이전 기기와 다릅니다.');
      if (current.version !== this.targetVersion) throw new Error(`재연결 후 버전이 ${current.version}입니다. ${this.targetVersion}을 확인하지 못했습니다.`);
    }
    if (after.local.version !== after.peer.version) throw new Error('적용 후 양쪽 버전이 다릅니다.');
    if (![0xffff, 0x0101].includes(after.local.state) || ![0xffff, 0x0101].includes(after.peer.state)) throw new Error('적용 후 상태가 정상 종료 상태가 아닙니다.');
    this.observedVersion = this.targetVersion;
    this.after = after;
    const pending = ['peer', 'local'].filter(route => after[route].state === 0x0101);
    if (!pending.length) {
      this.profile.confirmedRuntimeVersion = this.targetVersion;
      this.progress('complete', 100, `양쪽 ${this.targetVersion} 적용과 종료 상태를 확인했습니다.`);
      return after;
    }
    await this.checkBattery('peer'); await this.checkBattery('local');
    await this.client.transport.authorize?.(); this.client.writeEnabled = true; this.touched = true;
    this.progress('apply', 99, '양쪽 버전이 같습니다. 기기의 업데이트 기록을 마무리합니다.');
    for (const route of pending) await this.command(0x1c0a, [1, 255], {route});
    this.profile.confirmedRuntimeVersion = this.targetVersion;
    this.progress('complete', 100, `양쪽 ${this.targetVersion} 적용과 기기의 마무리 응답을 확인했습니다.`);
    return after;
  }
  async stopSingle() {
    const route = this.singleRoute;
    if (!route) return;
    if (this.client.transport?.closed) { this.log('연결이 없어 중단 명령을 보내지 못했습니다.'); return; }
    try { await this.command(0x1c03, [7, 1, 255, 1], {route, timeout: 3000}); }
    catch { this.log(`${route}: 중단 확인을 받지 못했습니다.`); }
    try { await this.command(0x0e02, [], {route, type: 0x5b, timeout: 3000}); }
    catch { this.log(`${route}: 오디오 복귀 확인을 받지 못했습니다.`); }
    this.log('중단 요청은 원래 펌웨어로 복구됐다는 뜻이 아닙니다. 현재 상태를 다시 확인해야 합니다.');
  }
  async stopAfterFailure() {
    if (this.client.transport?.closed) { this.log('연결이 없어 중단 명령을 보내지 못했습니다.'); return; }
    for (const route of ['peer', 'local']) {
      try { await this.command(0x1c03, [7, 1, 255, 1], {route, timeout: 3000}); }
      catch { this.log(`${route}: 중단 확인을 받지 못했습니다.`); }
    }
    for (const route of ['peer', 'local']) {
      try { await this.command(0x0e02, [], {route, type: 0x5b, timeout: 3000}); }
      catch { this.log(`${route}: 오디오 복귀 확인을 받지 못했습니다.`); }
    }
    this.log('중단 요청은 원래 펌웨어로 복구됐다는 뜻이 아닙니다. 현재 상태를 다시 확인해야 합니다.');
  }
  async verifyAfterReconnect({acceptObserved = false} = {}) {
    if (!this.commitStarted || !this.before) throw new Error('이 브라우저에서 적용한 전송 기록이 없습니다.');
    const after = await inspectDevice(this.client);
    for (const old of Object.values(this.before)) {
      const current = Object.values(after).find(d => d.channel === old.channel);
      if (!current || current.company !== old.company || current.module !== old.module) throw new Error('재연결한 기기의 제품이 이전 기기와 다릅니다.');
      if (current.version === old.version) throw new Error('재연결 후에도 이전 펌웨어 버전입니다. 업데이트 완료를 확인하지 못했습니다.');
    }
    if (after.local.version !== after.peer.version) throw new Error('적용 후 양쪽 버전이 다릅니다.');
    if (![0xffff, 0x0101].includes(after.local.state) || ![0xffff, 0x0101].includes(after.peer.state)) throw new Error('적용 후 상태가 정상 종료 상태가 아닙니다.');
    const observed = after.local.version;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(observed)) throw new Error('기기가 보고한 버전 형식을 확인하지 못했습니다: ' + observed);
    this.observedVersion = observed;
    this.after = after;
    const runtimeVersion = this.profile.confirmedRuntimeVersion || (acceptObserved ? observed : null);
    if (!runtimeVersion) {
      this.progress('review', 99, `양쪽 버전 변경 확인: ${observed}. 적용 버전으로 기록할지 확인해 주세요.`);
      return after;
    }
    if (!this.profile.confirmedRuntimeVersion) this.log(`실제 보고 버전 ${observed}을 적용 버전으로 기록합니다.`);
    return this.finalizeApplied(after, {runtimeVersion});
  }
  async finalizeApplied(previous, {runtimeVersion = this.profile.confirmedRuntimeVersion || this.observedVersion} = {}) {
    if (!runtimeVersion) throw new Error('배포 패키지의 실제 적용 버전이 아직 확인되지 않았습니다.');
    if (this.busy) throw new Error('다른 업데이트 작업이 진행 중입니다.');
    this.busy = true;
    try {
      const current = await inspectDevice(this.client);
      for (const old of Object.values(previous)) {
        const d = Object.values(current).find(d => d.channel === old.channel);
        if (!d || !sameIdentity(d, old)) throw new Error('적용 확인 중 기기 구성이 바뀌었습니다.');
      }
      const phase = validateAppliedPair(current, this.profile, {runtimeVersion});
      if (phase === 'complete') {
        this.profile.confirmedRuntimeVersion = runtimeVersion;
        this.progress('complete', 100, `양쪽 ${runtimeVersion} 적용과 종료 상태를 확인했습니다.`);
        return current;
      }
      await this.checkBattery('peer'); await this.checkBattery('local');
      await this.client.transport.authorize?.(); this.client.writeEnabled = true; this.touched = true;
      this.progress('apply', 99, '양쪽 버전 변경을 확인했습니다. 기기의 업데이트 기록을 마무리합니다.');
      // APK's post-reboot completion path for 0101 states: partner, then agent.
      // A side that already reports FFFF is complete and is not touched again.
      const pending = ['peer', 'local'].filter(route => current[route].state === 0x0101);
      for (const route of pending) await this.command(0x1c0a, [1, 255], {route});
      this.profile.confirmedRuntimeVersion = runtimeVersion;
      // Original SDK completes after both successful ACKs; it does not promise
      // a particular state value after these commands.
      this.progress('complete', 100, `양쪽 ${runtimeVersion} 적용과 기기의 마무리 응답을 확인했습니다.`);
      return current;
    } catch (error) {
      this.progress('uncertain', 99, error.message); throw error;
    } finally { this.busy = false; this.client.writeEnabled = false; await this.client.transport.revoke?.(); }
  }
}
