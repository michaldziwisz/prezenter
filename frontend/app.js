const publishForm = document.querySelector('#publish-form');
const statusBox = document.querySelector('#status');
const details = document.querySelector('#publication-details');
const apiUrlInput = document.querySelector('#api-url');
const bundleInput = document.querySelector('#bundle');
const bundleHint = document.querySelector('#bundle-hint');
const modeInputs = [...document.querySelectorAll('input[name="presentationMode"]')];

const roomApiUrl = document.querySelector('#room-api-url');
const roomIdInput = document.querySelector('#room-id');
const presenterKeyInput = document.querySelector('#presenter-key');
const syncStatus = document.querySelector('#sync-status');
const stateH = document.querySelector('#state-h');
const stateV = document.querySelector('#state-v');
const stateFragment = document.querySelector('#state-fragment');
const statePaused = document.querySelector('#state-paused');

let socket;
let presenter = false;
let slideState = {
  indexh: 0,
  indexv: 0,
  fragment: -1,
  paused: false
};

const params = new URLSearchParams(window.location.search);
const roomFromUrl = params.get('room');
const presenterKeyFromHash = new URLSearchParams(window.location.hash.slice(1)).get('presenterKey');
if (roomFromUrl) roomIdInput.value = roomFromUrl;
if (presenterKeyFromHash) presenterKeyInput.value = presenterKeyFromHash;

modeInputs.forEach((input) => {
  input.addEventListener('change', updateBundleMode);
});
bundleInput.addEventListener('change', validateBundleForMode);
updateBundleMode();

publishForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearDetails();
  validateBundleForMode();

  if (!publishForm.reportValidity()) {
    setStatus('Uzupełnij wymagane pola.', true);
    return;
  }

  const formData = new FormData();
  const bundle = bundleInput.files[0];
  formData.set('presentationMode', getPresentationMode());
  formData.set('title', document.querySelector('#title').value);
  formData.set('language', document.querySelector('#language').value);
  formData.set('license', document.querySelector('#license').value);
  formData.set('rightsConfirmed', String(document.querySelector('#rights-confirmed').checked));
  formData.set('publicConfirmed', String(document.querySelector('#public-confirmed').checked));
  formData.set('accessibilityConfirmed', String(document.querySelector('#a11y-confirmed').checked));
  formData.set('bundle', bundle);

  setStatus('Wysyłanie publikacji...');
  setFormDisabled(true);

  try {
    const response = await fetch(`${normalizeUrl(apiUrlInput.value)}/api/publish`, {
      method: 'POST',
      body: formData
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Nie udało się opublikować.');

    setStatus(`Publikacja przyjęta. Status: ${payload.status}.`);
    renderPublication(payload);
    pollStatus(payload.id);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setFormDisabled(false);
  }
});

document.querySelector('#create-room').addEventListener('click', async () => {
  setSyncStatus('Tworzenie pokoju...');
  try {
    const response = await fetch(`${normalizeUrl(roomApiUrl.value)}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Prezentacja' })
    });
    const room = await response.json();
    if (!response.ok) throw new Error(room.error || 'Nie udało się utworzyć pokoju.');
    roomIdInput.value = room.roomId;
    const key = new URL(room.presenterUrl || window.location.href).hash.slice(1);
    presenterKeyInput.value = new URLSearchParams(key).get('presenterKey') || '';
    setSyncStatus('Pokój utworzony.');
  } catch (error) {
    setSyncStatus(error.message, true);
  }
});

document.querySelector('#connect-presenter').addEventListener('click', () => connectLive(true));
document.querySelector('#connect-viewer').addEventListener('click', () => connectLive(false));
document.querySelector('#prev-slide').addEventListener('click', () => updateSlide({ indexh: Math.max(0, slideState.indexh - 1), fragment: -1 }));
document.querySelector('#next-slide').addEventListener('click', () => updateSlide({ indexh: slideState.indexh + 1, fragment: -1 }));
document.querySelector('#toggle-pause').addEventListener('click', () => updateSlide({ paused: !slideState.paused }));

async function pollStatus(publicationId) {
  for (let index = 0; index < 120; index += 1) {
    await wait(5000);
    try {
      const response = await fetch(`${normalizeUrl(apiUrlInput.value)}/api/publications/${publicationId}/status`);
      const payload = await response.json();
      if (response.ok) {
        setStatus(`Status: ${payload.status}.`);
        renderPublication(payload);
        if (['published', 'failed', 'awaiting_configuration'].includes(payload.status)) return;
      }
    } catch {
      return;
    }
  }
}

function connectLive(asPresenter) {
  const roomId = roomIdInput.value.trim();
  if (!roomId) {
    setSyncStatus('Podaj identyfikator pokoju.', true);
    roomIdInput.focus();
    return;
  }

  if (socket) socket.close();
  presenter = asPresenter;

  const apiUrl = normalizeUrl(roomApiUrl.value);
  const wsBase = apiUrl.replace(/^http/, 'ws');
  const url = new URL(`${wsBase}/ws/live`);
  url.searchParams.set('room', roomId);
  url.searchParams.set('role', asPresenter ? 'presenter' : 'viewer');
  if (asPresenter) url.searchParams.set('token', presenterKeyInput.value);

  socket = new WebSocket(url);
  setSyncStatus('Łączenie...');

  socket.addEventListener('open', () => {
    setSyncStatus(asPresenter ? 'Połączono jako prezenter.' : 'Połączono jako widz.');
  });
  socket.addEventListener('close', () => {
    setSyncStatus('Połączenie zamknięte.');
  });
  socket.addEventListener('error', () => {
    setSyncStatus('Błąd połączenia WebSocket.', true);
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'state') {
      slideState = { ...slideState, ...message.state };
      renderSlideState();
    }
  });
}

function updateSlide(patch) {
  if (!presenter || !socket || socket.readyState !== WebSocket.OPEN) {
    setSyncStatus('Sterowanie wymaga połączenia jako prezenter.', true);
    return;
  }
  slideState = { ...slideState, ...patch };
  socket.send(JSON.stringify({ type: 'state:update', state: slideState }));
  renderSlideState();
}

function renderSlideState() {
  stateH.textContent = String(slideState.indexh);
  stateV.textContent = String(slideState.indexv);
  stateFragment.textContent = String(slideState.fragment);
  statePaused.textContent = slideState.paused ? 'tak' : 'nie';
}

function renderPublication(publication) {
  clearDetails();
  addDetail('Identyfikator', publication.id);
  addDetail('Status', publication.status);
  addDetail('Format', formatPresentationMode(publication.presentationMode));
  addDetail('Źródło IA', publication.sourceIdentifier);
  addDetail('Wynik IA', publication.outputIdentifier);
  if (publication.resultUrl) addLinkDetail('Publikacja', publication.resultUrl);
  if (publication.accessibilityReport) addLinkDetail('Raport dostępności', publication.accessibilityReport);
  if (publication.viewerUrl) addLinkDetail('Link widza', publication.viewerUrl);
  if (publication.presenterUrl) addLinkDetail('Link prezentera', publication.presenterUrl);
  if (publication.missingConfiguration?.length) {
    addDetail('Brak konfiguracji', publication.missingConfiguration.join(', '));
  }
}

function addDetail(label, value) {
  const row = document.createElement('div');
  const term = document.createElement('dt');
  const desc = document.createElement('dd');
  term.textContent = label;
  desc.textContent = value || '-';
  row.append(term, desc);
  details.append(row);
}

function addLinkDetail(label, href) {
  const row = document.createElement('div');
  const term = document.createElement('dt');
  const desc = document.createElement('dd');
  const link = document.createElement('a');
  term.textContent = label;
  link.href = href;
  link.textContent = href;
  desc.append(link);
  row.append(term, desc);
  details.append(row);
}

function clearDetails() {
  details.replaceChildren();
}

function updateBundleMode() {
  const mode = getPresentationMode();
  bundleInput.accept = mode === 'pptx' ? '.pptx' : '.zip,.tar,.gz,.tgz,.md';
  bundleHint.textContent = mode === 'pptx'
    ? 'Obsługiwane: pojedynczy plik PPTX.'
    : 'Obsługiwane: ZIP, TAR, TGZ albo pojedynczy plik Markdown.';
  validateBundleForMode();
}

function validateBundleForMode() {
  const file = bundleInput.files[0];
  if (!file) {
    bundleInput.setCustomValidity('');
    bundleInput.removeAttribute('aria-invalid');
    return;
  }

  const name = file.name.toLowerCase();
  const mode = getPresentationMode();
  const valid = mode === 'pptx'
    ? name.endsWith('.pptx')
    : /\.(zip|tar|tar\.gz|tgz|md)$/.test(name);

  if (valid) {
    bundleInput.removeAttribute('aria-invalid');
  } else {
    bundleInput.setAttribute('aria-invalid', 'true');
  }

  bundleInput.setCustomValidity(valid
    ? ''
    : mode === 'pptx'
      ? 'Wybierz plik PPTX.'
      : 'Wybierz plik ZIP, TAR, TGZ albo Markdown.');
}

function getPresentationMode() {
  return modeInputs.find((input) => input.checked)?.value || 'markdown';
}

function formatPresentationMode(mode) {
  if (mode === 'pptx') return 'PPTX + PDF';
  return 'Markdown / reveal.js';
}

function setStatus(message, error = false) {
  statusBox.textContent = message;
  statusBox.classList.toggle('error', error);
}

function setSyncStatus(message, error = false) {
  syncStatus.textContent = message;
  syncStatus.classList.toggle('error', error);
}

function setFormDisabled(disabled) {
  publishForm.querySelectorAll('button, input, select').forEach((element) => {
    element.disabled = disabled;
  });
}

function normalizeUrl(value) {
  return value.replace(/\/+$/, '');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
