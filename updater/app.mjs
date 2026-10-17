import {AIROHA_UUID, MacTransport, SerialTransport, BleTransport, RaceClient, inspectDevice,
  isRecoveryState, validatePair, validateAppliedPair, validatePartialPair, verifyFirmware} from './protocol.mjs';
import {Updater} from './updater.mjs';

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const savedVersionKey = 'flycc-confirmed-runtime-version';
const stored = key => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
const forget = key => { try { localStorage.removeItem(key); } catch {} };
const state = {profile:null, transport:null, client:null, pair:null, files:null, updater:null,
  busy:false, applied:null, logs:[], remembered:null, permittedPort:null, recovery:false, observedVersion:null,
  partial:null, targetVersion:null, selected:{}};

function log(message) {
  state.logs.push({at:new Date().toISOString(), message});
  if (state.logs.length > 1000) state.logs.shift();
}
function error(e) {
  $('error').textContent = e.message || String(e);
  $('error').hidden = false;
  log($('error').textContent);
}
function clearError() { $('error').hidden = true; $('error').textContent = ''; }
function controls() {
  $('connect').disabled = state.busy || !state.profile;
  $('connect').hidden = !!state.pair;
  $('update').hidden = !state.pair || !!state.applied;
  $('update').disabled = state.busy || !state.files || !!state.updater?.touched;
  $('finish').hidden = state.applied !== 'finish';
  $('finish').disabled = state.busy;
  $('reconnect').disabled = state.busy;
}
function renderPair(pair) {
  $('version').textContent = pair.local.version === pair.peer.version
    ? pair.local.version
    : `L ${pair.peer.channel === 'left' ? pair.peer.version : pair.local.version} / R ${pair.peer.channel === 'right' ? pair.peer.version : pair.local.version}`;
}
function rememberVersion(version) {
  if (!version) return;
  state.observedVersion = version;
  state.profile.confirmedRuntimeVersion = version;
  store(savedVersionKey, version);
}
function progress({stage, percent, text}) {
  log(text);
  $('progress').hidden = !['check', 'transfer', 'apply'].includes(stage);
  $('fill').style.width = percent + '%';
  $('progress').setAttribute('aria-valuenow', Math.floor(percent));
  $('status').textContent = stage === 'complete' ? '이미 최신 버전입니다.'
    : stage === 'transfer' ? `업데이트 중 ${Math.floor(percent)}%` : text;
  if (['reconnect', 'review', 'uncertain'].includes(stage) && state.updater?.commitStarted) $('reconnect').hidden = false;
  if (stage === 'review') { state.applied = 'finish'; controls(); }
  if (stage === 'complete') {
    $('reconnect').hidden = true;
    state.applied = 'complete';
    rememberVersion(state.updater?.observedVersion);
    controls();
  }
}
async function verifySelectedFile(side) {
  const input = $(`${side}-file`), status = $(`${side}-file-status`);
  const selected = input.files?.[0];
  if (!selected) {
    delete state.selected[side];
    status.textContent = '';
    status.classList.remove('ok');
    return false;
  }
  try {
    const bytes = new Uint8Array(await selected.arrayBuffer());
    await verifyFirmware(bytes, state.profile.files[side]);
    state.selected[side] = bytes;
    status.textContent = `확인됨: ${selected.name}`;
    status.classList.add('ok');
    return true;
  } catch (e) {
    delete state.selected[side];
    status.textContent = e.message;
    status.classList.remove('ok');
    return false;
  }
}
async function loadSelectedFiles() {
  const left = await verifySelectedFile('left');
  const right = await verifySelectedFile('right');
  state.files = left && right ? {left:state.selected.left, right:state.selected.right} : null;
  if (state.files && state.pair) {
    $('status').textContent = state.partial ? `한쪽이 이미 ${state.targetVersion}입니다. 남은 쪽만 업데이트합니다.`
      : state.recovery ? '중단된 업데이트를 이어서 진행할 수 있습니다.' : '새로운 업데이트가 있습니다.';
  }
  controls();
}
function createTransport() {
  if (MacTransport.available()) return new MacTransport(log);
  if (state.remembered) return new BleTransport(log, state.remembered);
  return new SerialTransport(log, state.permittedPort);
}
async function connect() {
  if (state.busy) return;
  clearError();
  state.busy = true; state.pair = null; state.applied = null; state.files = null;
  state.updater = null; state.recovery = false; state.observedVersion = null;
  state.partial = null; state.targetVersion = null;
  const transport = createTransport();
  let opened = false;
  try {
    const selection = transport.select();
    controls(); $('status').textContent = '연결 중...';
    await selection; opened = true;
    state.transport = transport; state.client = new RaceClient(transport, log);
    const pair = await inspectDevice(state.client);
    renderPair(pair);
    const confirmed = state.profile.confirmedRuntimeVersion;
    if (confirmed && Object.values(pair).every(d => d.version === confirmed)) {
      state.applied = validateAppliedPair(pair, state.profile, {runtimeVersion:confirmed});
      state.pair = pair;
      $('status').textContent = state.applied === 'complete' ? '이미 최신 버전입니다.' : '새 버전 적용을 마무리해 주세요.';
    } else {
      try {
        validatePair(pair, state.profile);
      } catch (e) {
        if (isRecoveryState(pair)) {
          validatePair(pair, state.profile, {allowRecovery:true});
          state.recovery = true;
        } else {
          for (const version of [pair.local.version, pair.peer.version]) {
            try { state.partial = validatePartialPair(pair, state.profile, version); break; } catch {}
          }
          if (!state.partial) throw e;
          state.targetVersion = state.partial.updated.version;
          state.recovery = state.partial.old.state === 0x0311;
        }
      }
      state.pair = pair;
      $('status').textContent = state.files
        ? (state.partial ? `한쪽이 이미 ${state.targetVersion}입니다. 남은 쪽만 업데이트합니다.`
          : state.recovery ? '중단된 업데이트를 이어서 진행할 수 있습니다.' : '새로운 업데이트가 있습니다.')
        : '기기는 연결되었습니다. 펌웨어 파일을 선택하면 업데이트할 수 있습니다.';
    }
    if (!state.files) await loadSelectedFiles();
    if (transport instanceof BleTransport) {
      state.remembered = transport.device;
      store('flycc-bluetooth-device', transport.device.id);
    }
    if (transport instanceof SerialTransport && transport.port) state.permittedPort = transport.port;
  } catch (e) {
    state.pair = null;
    await transport.close().catch(() => {});
    state.transport = null; state.client = null;
    // Only forget a BLE permission when the connection itself was never opened.
    if (transport instanceof BleTransport && !opened) {
      state.remembered = null;
      forget('flycc-bluetooth-device');
    }
    $('status').textContent = '';
    if (e.name !== 'NotFoundError') error(e);
  } finally { state.busy = false; controls(); }
}
async function run() {
  if (!state.files) { error(new Error('펌웨어 파일을 먼저 선택해 주세요.')); return; }
  if (state.busy || !state.pair) return;
  clearError();
  state.busy = true; controls();
  let wake;
  try {
    wake = await navigator.wakeLock?.request('screen').catch(() => null);
    state.updater = new Updater(state.client, state.profile, {onProgress:progress, log});
    if (state.partial) {
      await state.updater.completeSingle(state.pair, state.files, {route:state.partial.old.route,
        targetVersion:state.targetVersion, confirmed:true, recovery:state.recovery});
    } else {
      await state.updater.start(state.pair, state.files, {confirmed:true, recovery:state.recovery});
    }
  } catch (e) { error(e); }
  finally { await wake?.release().catch(() => {}); state.busy = false; controls(); }
}
async function reconnectTransport() {
  let last;
  for (let attempt = 1; attempt <= 12; attempt++) {
    try { await state.transport.reconnect(); return; }
    catch (e) {
      last = e;
      log(`기기 재연결 대기 ${attempt}/12: ${e.message}`);
      await sleep(5000);
    }
  }
  throw last;
}
async function reconnect() {
  if (state.busy || !state.updater?.commitStarted) return;
  clearError();
  state.busy = true; controls();
  try {
    await reconnectTransport();
    state.client.peer = null;
    state.client.framer.buffer = new Uint8Array();
    const after = state.partial ? await state.updater.verifyPartialAfterReconnect() : await state.updater.verifyAfterReconnect({acceptObserved:true});
    state.pair = after;
    state.updater.after = after;
    renderPair(after);
    if (state.updater.stage === 'review') {
      state.applied = 'finish';
      $('status').textContent = `양쪽 ${after.local.version} 확인. 적용 기록을 마무리해 주세요.`;
    }
  } catch (e) { error(e); }
  finally { state.busy = false; controls(); }
}
async function finish() {
  if (state.busy || state.applied !== 'finish') return;
  clearError();
  state.busy = true; controls();
  try {
    state.updater ||= new Updater(state.client, state.profile, {onProgress:progress, log});
    const version = state.updater.observedVersion || state.profile.confirmedRuntimeVersion;
    const previous = state.updater.after || state.pair;
    state.pair = await state.updater.finalizeApplied(previous, {runtimeVersion:version});
    renderPair(state.pair);
    rememberVersion(version);
    state.applied = 'complete';
    $('status').textContent = '이미 최신 버전입니다.';
  } catch (e) { error(e); }
  finally { state.busy = false; controls(); }
}
$('connect').addEventListener('click', connect);
$('update').addEventListener('click', () => {
  if ($('update').disabled) return;
  $('confirmation').querySelector('p').textContent = state.partial
    ? '이미 적용된 한쪽은 건드리지 않고 남은 한쪽만 업데이트합니다. 완료될 때까지 창을 닫지 마세요.'
    : state.recovery
      ? '중단된 업데이트를 이어서 진행합니다. 완료될 때까지 기기 전원을 켜 두고 이 창을 닫지 마세요.'
      : '완료될 때까지 기기 전원을 켜 두고 이 창을 닫지 마세요.';
  $('confirmation').showModal();
});
$('confirmation').addEventListener('close', () => { if ($('confirmation').returnValue === 'start') run(); });
$('reconnect').addEventListener('click', reconnect);
$('finish').addEventListener('click', finish);
$('left-file').addEventListener('change', loadSelectedFiles);
$('right-file').addEventListener('change', loadSelectedFiles);
addEventListener('beforeunload', e => { if (state.busy && state.updater?.touched) { e.preventDefault(); e.returnValue = ''; } });

async function boot() {
  try {
    const response = await fetch('./profile.json');
    if (!response.ok) throw new Error('업데이트 정보를 불러오지 못했습니다.');
    state.profile = await response.json();
    const saved = stored(savedVersionKey);
    if (!state.profile.confirmedRuntimeVersion && saved) state.profile.confirmedRuntimeVersion = saved;
  } catch (e) { error(e); controls(); return; }
  try {
    const saved = stored('flycc-bluetooth-device');
    if (saved && navigator.bluetooth?.getDevices) {
      state.remembered = (await navigator.bluetooth.getDevices()).find(d => d.id === saved) || null;
    }
  } catch (e) { log('저장된 Bluetooth 기기를 확인하지 못했습니다: ' + e.message); }
  try {
    if (navigator.serial) {
      const ports = (await navigator.serial.getPorts()).filter(p => p.getInfo().bluetoothServiceClassId?.toLowerCase() === AIROHA_UUID);
      if (ports.length === 1) state.permittedPort = ports[0];
    }
  } catch (e) { log('허용된 Serial 포트를 확인하지 못했습니다: ' + e.message); }
  $('left-file-name').textContent = `기대 파일: ${state.profile.files.left.name}`;
  $('right-file-name').textContent = `기대 파일: ${state.profile.files.right.name}`;
  if (!MacTransport.available()) {
    const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
    $('host-note').hidden = false;
    $('host-note').textContent = isMac
      ? 'macOS에서는 Chrome만으로 기기의 RFCOMM 채널을 열 수 없습니다. macOS 앱 또는 Chrome 도우미를 사용해 주세요.'
      : '웹 업데이터는 실험적입니다. Chrome 또는 Edge에서 Serial 권한을 허용하고 기기를 연결해 주세요.';
  }
  controls();
  // The background connector serves this page and already handles the RFCOMM
  // channel; opening the page should be enough to show the current version.
  if (MacTransport.available()) connect();
}
await boot();
