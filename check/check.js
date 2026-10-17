const form = document.querySelector('#check-form');
const result = document.querySelector('#result');
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function render(kind, title, body) {
  result.className = 'result ' + kind;
  result.innerHTML = '<strong>' + title + '</strong><br>' + body;
  result.hidden = false;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const company = form.company.value;
  const module = form.module.value;
  const version = form.version.value.trim().replace(/^v/i, '');
  result.hidden = true;
  let support;
  try {
    const response = await fetch('./support.json', {cache:'no-cache'});
    support = await response.json();
  } catch {
    render('bad', '목록을 불러오지 못했습니다.', '잠시 후 다시 시도해 주세요.');
    return;
  }
  if (company !== support.company || module !== support.module) {
    render('bad', '지원하지 않는 조합입니다.', '이 도구는 ' + support.company + ' / ' + support.module + ' 전용입니다.');
    return;
  }
  if (version === support.targetRuntime) {
    render('ok', '이미 최신 버전입니다.', '현재 버전이 ' + support.targetRuntime + '로 확인되었습니다. 추가 전송이 필요하지 않습니다.');
    return;
  }
  if (support.versions.includes(version)) {
    render('ok', '업데이트할 수 있습니다.', '대상 런타임은 ' + support.targetRuntime + '입니다. 실제 기기 상태와 배터리는 연결 후 다시 검사합니다.');
    return;
  }
  render('neutral', '지원 목록에 없는 버전입니다.', '입력한 버전은 ' + esc(version || '(비어 있음)') + '입니다. 임의로 전송하지 말고 실제 기기에서 버전을 다시 확인해 주세요.');
});
