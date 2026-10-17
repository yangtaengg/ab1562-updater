export const AIROHA_UUID = '00000000-0000-0000-0099-aabbccddeeff';
export const BLE_SERVICE = '5052494d-2dab-0341-6972-6f6861424c45';
export const BLE_TX = '43484152-2dab-3241-6972-6f6861424c45';
export const BLE_RX = '43484152-2dab-3141-6972-6f6861424c45';
export const u16 = n => Uint8Array.of(n & 255, n >>> 8 & 255);
export const u32 = n => Uint8Array.of(n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255);
export const read16 = (b, n = 0) => b[n] | b[n + 1] << 8;
export const read32 = (b, n = 0) => (b[n] | b[n + 1] << 8 | b[n + 2] << 16 | b[n + 3] << 24) >>> 0;
export const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; } return out;
};
export function frame(id, payload = [], type = 0x5a) {
  if (payload.length > 65533) throw new Error('명령 크기를 초과했습니다.');
  return concat([5, type], u16(payload.length + 2), u16(id), payload);
}
export function decode(raw) {
  if (raw.length < 6 || read16(raw, 2) + 4 !== raw.length) throw new Error('RACE 프레임 길이가 맞지 않습니다.');
  return {raw, id: read16(raw, 4), type: raw[1], body: raw.subarray(6)};
}
export class Framer {
  constructor(onFrame) { this.buffer = new Uint8Array(); this.onFrame = onFrame; }
  push(bytes) {
    this.buffer = concat(this.buffer, bytes);
    while (this.buffer.length >= 6) {
      const b = this.buffer;
      if (![5, 0x15].includes(b[0]) || ![0x5a, 0x5b, 0x5c, 0x5d].includes(b[1]) || read16(b, 2) < 2) {
        this.buffer = b.subarray(1); continue;
      }
      const size = read16(b, 2) + 4;
      if (b.length < size) return;
      this.onFrame(decode(b.slice(0, size))); this.buffer = b.slice(size);
    }
  }
}
export class SerialTransport {
  constructor(log = () => {}, port = null) { this.log = log; this.port = port; this.onBytes = () => {}; this.onDisconnect = () => {}; }
  async select() {
    if (!navigator.serial) throw new Error('데스크톱 Chrome에서 열어 주세요.');
    if (!this.port) this.port = await navigator.serial.requestPort({allowedBluetoothServiceClassIds: [AIROHA_UUID], filters: [{bluetoothServiceClassId: AIROHA_UUID}]});
    const info = this.port.getInfo();
    if (info.bluetoothServiceClassId?.toLowerCase() !== AIROHA_UUID) throw new Error('Airoha 전용 서비스를 선택해 주세요.');
    await this.open();
  }
  async open() {
    try { await this.port.open({baudRate: 115200, bufferSize: 65536}); }
    catch (cause) {
      const error = new Error('기기를 찾았지만 Chrome이 Bluetooth 연결을 열지 못했습니다.');
      error.code = 'SERIAL_OPEN_FAILED'; error.cause = cause; throw error;
    }
    this.writer = this.port.writable.getWriter(); this.closed = false;
    this.loop = this.readLoop();
  }
  async readLoop() {
    this.reader = this.port.readable.getReader();
    try {
      while (!this.closed) { const {value, done} = await this.reader.read(); if (done) break; if (value) this.onBytes(value); }
    } catch (error) { if (!this.closed) this.log('연결 수신 종료: ' + error.message); }
    finally {
      this.reader.releaseLock(); this.reader = null;
      if (!this.closed) { this.closed = true; this.onDisconnect(new Error('기기 연결이 끊겼습니다.')); }
    }
  }
  async write(bytes) { if (this.closed || !this.writer) throw new Error('기기와 연결되어 있지 않습니다.'); await this.writer.write(bytes); }
  async close() {
    this.closed = true;
    if (this.reader) await this.reader.cancel().catch(() => {});
    await this.loop?.catch(() => {});
    this.writer?.releaseLock(); this.writer = null;
    await this.port?.close().catch(() => {});
  }
  async reconnect() { await this.close(); await this.open(); }
}
export class BleTransport {
  constructor(log = () => {}, device = null) {
    this.log = log; this.closed = true; this.onBytes = () => {}; this.onDisconnect = () => {};
    this.device = device;
    this.receive = event => {
      const value = event.target.value;
      this.onBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
    };
    this.disconnected = () => {
      if (!this.closed) { this.closed = true; this.onDisconnect(new Error('BLE 연결이 끊겼습니다.')); }
    };
  }
  async select() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth를 지원하는 Chrome에서 열어 주세요.');
    if (!this.device) this.device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [BLE_SERVICE]
    });
    this.device.addEventListener('gattserverdisconnected', this.disconnected);
    await this.open();
  }
  async open() {
    this.log('BLE 서비스에 연결하고 있습니다.');
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(BLE_SERVICE);
    this.tx = await service.getCharacteristic(BLE_TX);
    this.rx = await service.getCharacteristic(BLE_RX);
    if (!this.tx.properties.write && !this.tx.properties.writeWithoutResponse) throw new Error('이 BLE 서비스는 전송을 지원하지 않습니다.');
    this.rx.addEventListener('characteristicvaluechanged', this.receive);
    await this.rx.startNotifications();
    this.closed = false; this.log('BLE 알림 수신과 전송 준비 완료');
  }
  async write(bytes) {
    if (this.closed || !this.device?.gatt.connected) throw new Error('BLE 기기와 연결되어 있지 않습니다.');
    // APK H4Transport uses a byte stream. 20 bytes also fits the minimum ATT MTU.
    for (let offset = 0; offset < bytes.length; offset += 20) {
      const chunk = bytes.slice(offset, offset + 20);
      if (this.tx.properties.write) await this.tx.writeValueWithResponse(chunk);
      else await this.tx.writeValueWithoutResponse(chunk);
    }
  }
  async close() {
    this.closed = true;
    this.rx?.removeEventListener('characteristicvaluechanged', this.receive);
    this.device?.gatt.disconnect();
    this.tx = null; this.rx = null;
  }
  async reconnect() { await this.close(); await this.open(); }
}
export class MacTransport {
  static available() { return location.hostname === '127.0.0.1' && location.port === '8768'; }
  constructor(log = () => {}) {
    this.log = log; this.onBytes = () => {}; this.onDisconnect = () => {}; this.closed = true;
  }
  async api(path, body = {}) {
    let response;
    try {
      response = await fetch('/api/' + path, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-FlyCC-Session': 'local'}, body: JSON.stringify(body)});
    } catch { this.closed = true; throw new Error('Mac 연결 앱과 통신할 수 없습니다. 앱이 켜져 있는지 확인해 주세요.'); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Mac 연결 앱 요청에 실패했습니다.');
    return result;
  }
  async select() {
    if (!MacTransport.available()) throw new Error('Mac 연결 앱에서 Chrome 화면을 열어 주세요.');
    for (let attempt = 1; ; attempt++) {
      try { await this.api('connect'); break; }
      catch (error) {
        // A launch-time connection can still be in progress.  A plain timeout
        // means the earbuds are off, so retry that only once.
        const conflict = /진행 중/.test(error.message);
        const timeout = /시간이 초과/.test(error.message);
        if (attempt >= 6 || (!conflict && !(timeout && attempt < 2))) throw error;
        this.log(conflict ? 'Mac 연결 앱의 이전 연결 시도를 기다립니다.' : '기기 연결을 다시 시도합니다.');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
    this.closed = false; this.log('Mac 연결 앱을 통한 Bluetooth 연결 완료');
  }
  async write(bytes) {
    if (this.closed) throw new Error('Mac 연결 앱에 연결되어 있지 않습니다.');
    const data = btoa(String.fromCharCode(...bytes));
    const result = await this.api('command', {data});
    this.onBytes(Uint8Array.from(atob(result.data), c => c.charCodeAt(0)));
  }
  async authorize() { await this.api('authorize', {confirmed: true}); }
  async revoke() { await this.api('revoke').catch(() => {}); }
  async close() { this.closed = true; await this.api('disconnect').catch(() => {}); }
  async reconnect() { await this.close(); await this.select(); }
}
export class RaceClient {
  constructor(transport, log = () => {}) {
    this.transport = transport; this.log = log; this.pending = null; this.peer = null;
    this.framer = new Framer(f => this.receive(f));
    transport.onBytes = b => this.framer.push(b);
    transport.onDisconnect = e => this.fail(e);
    this.writeEnabled = false;
  }
  fail(error) { this.pending?.reject(error); }
  receive(packet) {
    let route = 'local';
    if (packet.id === 0x0d01) {
      if (packet.type !== 0x5d || packet.body.length < 8 || !this.peer ||
          packet.body[0] !== this.peer[0] || packet.body[1] !== this.peer[1]) return;
      try { packet = decode(packet.body.subarray(2)); route = 'peer'; } catch { return; }
    }
    const wait = this.pending;
    if (wait && wait.id === packet.id && wait.route === route && wait.type === packet.type && (!wait.match || wait.match(packet))) {
      wait.resolve(packet);
    }
  }
  async request(id, payload = [], options = {}) {
    if (this.pending) throw new Error('동시에 두 개의 기기 명령을 실행할 수 없습니다.');
    const route = options.route || 'local';
    if (route === 'peer' && !this.peer) throw new Error('반대쪽 기기를 확인하지 못했습니다.');
    if (!options.readOnly && !this.writeEnabled) throw new Error('업데이트 시작 승인이 필요합니다.');
    let bytes = frame(id, payload);
    if (route === 'peer') bytes = frame(0x0d01, concat(this.peer, bytes));
    this.log(`${route === 'peer' ? '파트너' : '연결 기기'} 명령 0x${id.toString(16).padStart(4, '0')}`);
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        this.pending = {id, route, type: options.type ?? 0x5d, match: options.match, resolve, reject};
        timer = setTimeout(() => reject(new Error(`명령 0x${id.toString(16)} 응답 시간 초과`)), options.timeout ?? 10000);
        this.transport.write(bytes).catch(reject);
      });
    } finally { clearTimeout(timer); this.pending = null; }
  }
  read(id, payload = [], options = {}) { return this.request(id, payload, {...options, readOnly: true}); }
  async destinations() {
    const p = await this.read(0x0d00, [], {type: 0x5b});
    const found = [];
    for (let i = 0; i + 1 < p.body.length; i += 2) if (p.body[i] === 5) found.push(p.body.slice(i, i + 2));
    if (found.length !== 1) throw new Error('반대쪽 기기를 찾지 못했습니다. 양쪽 전원이 켜져 있는지 확인해 주세요.');
    this.peer = found[0]; return this.peer;
  }
}
const ascii = b => new TextDecoder('utf-8', {fatal: true}).decode(b.subarray(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0))).trim();
export function recipientData(packet) {
  const b = packet.body;
  if (b.length < 4 || b[0] !== 0 || b[1] !== 1 || b[2] !== 255 || b.length !== b[3] + 4) throw new Error('제품 정보 응답 형식이 다릅니다.');
  return b.subarray(4);
}
export function parseIdentity(packet) {
  const b = recipientData(packet);
  if (b.length !== 49) throw new Error('지원하지 않는 제품 정보 형식입니다.');
  return {company: ascii(b.subarray(9, 29)), module: ascii(b.subarray(29, 49)),
    version: `${b[0]}.${b[1]}.${read16(b, 2)}.${read16(b, 4)}`,
    releaseDate: `${2000 + b[6]}-${String(b[7]).padStart(2, '0')}-${String(b[8]).padStart(2, '0')}`};
}
export function parsePartitions(packet) {
  const b = packet.body;
  if (b.length < 2 || b[0] !== 0 || b[1] < 1 || b.length !== 2 + b[1] * 11) throw new Error('파티션 응답 형식이 다릅니다.');
  const out = [];
  for (let n = 2; n < b.length; n += 11) out.push({recipient: b[n], id: b[n + 1], storage: b[n + 2], address: read32(b, n + 3), length: read32(b, n + 7)});
  return out;
}
export function parseState(packet) {
  const b = packet.body;
  if (b.length !== 5 || ![0, 0xd0, 0xd1].includes(b[0]) || b[1] !== 1 || b[2] !== 255) throw new Error('기기 상태 응답 형식이 다릅니다.');
  return read16(b, 3);
}
export async function inspectDevice(client) {
  await client.destinations(); const result = {};
  for (const route of ['local', 'peer']) {
    const query = (id, p, type = 0x5d) => client.read(id, p, {route, type});
    const info = parseIdentity(await query(0x1c09, [1, 255]));
    const version = ascii(recipientData(await query(0x1c07, [1, 255])));
    if (version !== info.version) throw new Error('두 버전 조회의 결과가 다릅니다. 다시 연결해 주세요.');
    const channelPacket = await query(0x0a00, [0xb5, 0xf2, 0xe8, 3], 0x5b);
    if (channelPacket.raw.length < 13 || ![1, 2].includes(channelPacket.raw[9])) throw new Error('좌우 채널을 확정할 수 없습니다.');
    const channel = channelPacket.raw[9] === 2 ? 'right' : 'left';
    const batteryPacket = await query(0x0cd6, [0]);
    if (batteryPacket.body.length < 3 || batteryPacket.body[0] !== 0 || batteryPacket.body[2] > 100) throw new Error('배터리를 확인하지 못했습니다.');
    const partitions = parsePartitions(await query(0x1c00, [2, 255, 0, 255, 1]));
    const state = parseState(await query(0x1c04, [1, 255]));
    result[route] = {...info, route, channel, battery: batteryPacket.body[2], partitions, state};
  }
  if (result.local.channel === result.peer.channel) throw new Error('양쪽 기기의 좌우 채널이 중복됩니다.');
  return result;
}
const companyBase = x => x.replace(/ max$/, '');
export function catalogEntry(profile, device) {
  const keys = [`${device.company}_${profile.moduleBase}_V${device.version}`,
    `${companyBase(device.company)}_${profile.moduleBase}_V${device.version}`];
  for (const key of keys) {
    const entry = profile.catalog[key];
    if (entry?.includes('_V' + profile.targetPackage + '_fota')) return entry;
  }
  return null;
}
export function isRecoveryState(pair) {
  const states = Object.values(pair).map(d => d.state);
  return states.some(s => s === 0x0311) && states.every(s => s === 0xffff || s === 0x0311);
}
export function validatePair(pair, profile, {allowPending = false, allowRecovery = false} = {}) {
  for (const d of Object.values(pair)) {
    const suffix = d.channel === 'left' ? '_L' : '_R';
    if (d.module !== profile.moduleBase + suffix) throw new Error('이 펌웨어와 다른 모듈입니다: ' + d.module);
    if (!catalogEntry(profile, d)) throw new Error('현재 제품과 버전에 해당하는 배포 항목이 없습니다.');
    if (d.battery < 60) throw new Error(`${d.channel === 'left' ? '왼쪽' : '오른쪽'} 배터리를 60% 이상 충전해 주세요.`);
    const allowed = allowRecovery ? [0xffff, 0x0311] : allowPending ? [0x0311] : [0xffff, 0x0101];
    if (!allowed.includes(d.state)) throw new Error('새 업데이트를 시작할 수 없는 기기 상태입니다: 0x' + d.state.toString(16));
    const fota = d.partitions.find(p => p.id === 0 && p.recipient === 255);
    const fs = d.partitions.find(p => p.id === 1 && p.recipient === 255);
    if (!fota || !fs || fota.storage !== 0 || fota.length === 0 || fota.address === fs.address) throw new Error('지원하지 않는 파티션 구성입니다. 파일시스템을 함께 갱신하는 2MB 기기는 지원하지 않습니다.');
  }
  if (allowRecovery && !isRecoveryState(pair)) throw new Error('이어서 진행할 중단된 업데이트 상태가 아닙니다.');
  if (companyBase(pair.local.company) !== companyBase(pair.peer.company)) throw new Error('양쪽 기기의 제품이 서로 다릅니다.');
  return true;
}
export function validatePartialPair(pair, profile, targetVersion) {
  if (!targetVersion) throw new Error('적용된 새 버전을 확인하지 못했습니다.');
  const devices = Object.values(pair);
  if (devices.length !== 2 || pair.local.channel === pair.peer.channel) throw new Error('양쪽 좌우 채널이 중복됩니다.');
  const updated = devices.filter(d => d.version === targetVersion);
  if (updated.length !== 1) throw new Error('한쪽만 새 버전인 상태가 아닙니다.');
  const current = updated[0], old = devices.find(d => d !== current);
  if (![0xffff, 0x0101].includes(current.state)) throw new Error('새 버전 기기의 상태를 확인할 수 없습니다: 0x' + current.state.toString(16));
  if (![0xffff, 0x0311].includes(old.state)) throw new Error('이전 버전 기기의 상태를 확인할 수 없습니다: 0x' + old.state.toString(16));
  if (!catalogEntry(profile, old)) throw new Error('이전 버전 기기에 해당하는 배포 항목이 없습니다.');
  for (const d of devices) {
    const suffix = d.channel === 'left' ? '_L' : '_R';
    if (d.module !== profile.moduleBase + suffix) throw new Error('이 펌웨어와 다른 모듈입니다: ' + d.module);
    if (d.battery < 60) throw new Error(`${d.channel === 'left' ? '왼쪽' : '오른쪽'} 배터리를 60% 이상 충전해 주세요.`);
    const fota = d.partitions.find(p => p.id === 0 && p.recipient === 255);
    const fs = d.partitions.find(p => p.id === 1 && p.recipient === 255);
    if (!fota || !fs || fota.storage !== 0 || fota.length === 0 || fota.address === fs.address) throw new Error('지원하지 않는 파티션 구성입니다. 파일시스템을 함께 갱신하는 2MB 기기는 지원하지 않습니다.');
  }
  if (companyBase(pair.local.company) !== companyBase(pair.peer.company)) throw new Error('양쪽 기기의 제품이 서로 다릅니다.');
  return {updated:current, old};
}
export function validateAppliedPair(pair, profile, {runtimeVersion = profile.confirmedRuntimeVersion} = {}) {
  if (!runtimeVersion) throw new Error('배포 패키지의 실제 적용 버전이 아직 확인되지 않았습니다.');
  for (const d of Object.values(pair)) {
    const expectedModule = profile.moduleBase + (d.channel === 'left' ? '_L' : '_R');
    const knownModel = Object.keys(profile.catalog).some(k =>
      k.startsWith(d.company + '_' + profile.moduleBase + '_V') ||
      k.startsWith(companyBase(d.company) + '_' + profile.moduleBase + '_V'));
    if (d.module !== expectedModule || !knownModel ||
        d.version !== runtimeVersion) throw new Error('확인된 배포 버전 및 제품과 일치하지 않습니다.');
  }
  if (pair.local.channel === pair.peer.channel) throw new Error('양쪽 좌우 채널이 중복됩니다.');
  const states = Object.values(pair).map(d => d.state);
  if (states.every(s => s === 0xffff)) return 'complete';
  if (states.every(s => s === 0xffff || s === 0x0101)) return 'finish';
  throw new Error('적용 후 양쪽 상태가 정상 종료 상태로 일치하지 않습니다. 다시 전송하지 말고 상태를 확인해 주세요.');
}
export async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function verifyFirmware(bytes, file) {
  if (bytes.length !== file.size || await sha256(bytes) !== file.sha256) throw new Error('펌웨어 파일의 SHA-256 또는 크기가 맞지 않습니다.');
  const header = [...bytes.subarray(0, 32)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (await sha256(bytes.subarray(256)) !== header) throw new Error('펌웨어 내부 검사값이 맞지 않습니다.');
  return bytes;
}
