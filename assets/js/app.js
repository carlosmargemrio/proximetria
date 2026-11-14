(() => {
  'use strict';

  const state = {
    config: null,
    sites: [],
    meta: null,
    details: null,
    map: null,
    markers: null,
    userMarker: null,
    radiusCircle: null,
    results: [],
    page: 1,
    userLat: null,
    userLon: null,
    worker: null,
    workerReady: false,
    pendingRequests: new Map(),
    requestSeq: 0,
    pickOnMap: false,
    deferredInstall: null
  };

  const el = {};
  const byId = (id) => document.getElementById(id);

  document.addEventListener('DOMContentLoaded', boot);

  async function boot() {
    cacheElements();
    initTheme();
    initNetworkStatus();
    initPwaInstall();
    bindEvents();

    try {
      state.config = await fetchJson('./config.json', { cache: 'no-cache' });
      await waitForLibraries();
      initMap();
      await loadDataset();
      initWorker();
      registerServiceWorker();
    } catch (error) {
      console.error(error);
      showDatasetError(error);
    }
  }

  function cacheElements() {
    Object.assign(el, {
      networkBadge: byId('networkBadge'),
      installButton: byId('installButton'),
      themeButton: byId('themeButton'),
      coordInput: byId('coordInput'),
      marginInput: byId('marginInput'),
      radiusInput: byId('radiusInput'),
      ufFilter: byId('ufFilter'),
      imageInput: byId('imageInput'),
      imageStatus: byId('imageStatus'),
      calculateButton: byId('calculateButton'),
      pickMapButton: byId('pickMapButton'),
      useLocationButton: byId('useLocationButton'),
      datasetStatus: byId('datasetStatus'),
      resultSummary: byId('resultSummary'),
      emptyState: byId('emptyState'),
      tableWrap: byId('tableWrap'),
      resultsBody: byId('resultsBody'),
      pagination: byId('pagination'),
      csvButton: byId('csvButton'),
      detailDialog: byId('detailDialog'),
      detailTitle: byId('detailTitle'),
      detailContent: byId('detailContent'),
      toast: byId('toast'),
      mapHint: byId('mapHint')
    });
  }

  function bindEvents() {
    el.themeButton.addEventListener('click', toggleTheme);
    el.calculateButton.addEventListener('click', calculateFromInput);
    el.coordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') calculateFromInput();
    });
    el.pickMapButton.addEventListener('click', () => {
      state.pickOnMap = !state.pickOnMap;
      el.pickMapButton.textContent = state.pickOnMap ? 'Clique no mapa…' : 'Escolher no mapa';
      el.pickMapButton.classList.toggle('primary', state.pickOnMap);
      showToast(state.pickOnMap ? 'Clique no mapa para definir o ponto da consulta.' : 'Seleção no mapa cancelada.');
    });
    el.useLocationButton.addEventListener('click', useDeviceLocation);
    el.imageInput.addEventListener('change', handleImageExif);
    el.csvButton.addEventListener('click', exportCsv);
    el.ufFilter.addEventListener('change', () => {
      if (Number.isFinite(state.userLat) && Number.isFinite(state.userLon)) runCalculation(state.userLat, state.userLon);
    });
  }

  function initTheme() {
    const saved = localStorage.getItem('proximetria-theme');
    const preferred = window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.dataset.theme = saved || preferred;
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('proximetria-theme', next);
  }

  function initNetworkStatus() {
    const refresh = () => {
      const online = navigator.onLine;
      el.networkBadge.textContent = online ? 'Online' : 'Offline';
      el.networkBadge.classList.toggle('online', online);
      el.networkBadge.classList.toggle('offline', !online);
    };
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    refresh();
  }

  function initPwaInstall() {
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      state.deferredInstall = event;
      el.installButton.hidden = false;
    });
    el.installButton.addEventListener('click', async () => {
      if (!state.deferredInstall) return;
      state.deferredInstall.prompt();
      await state.deferredInstall.userChoice;
      state.deferredInstall = null;
      el.installButton.hidden = true;
    });
    window.addEventListener('appinstalled', () => {
      state.deferredInstall = null;
      el.installButton.hidden = true;
      showToast('ProxiMetria instalada neste dispositivo.');
    });
  }

  async function waitForLibraries() {
    const started = Date.now();
    while ((!window.L || !window.proj4) && Date.now() - started < 10000) {
      await new Promise(r => setTimeout(r, 60));
    }
    if (!window.L) throw new Error('A biblioteca do mapa (Leaflet) não foi carregada.');
    if (!window.proj4) throw new Error('A biblioteca de conversão UTM (proj4) não foi carregada.');
  }

  function initMap() {
    state.map = L.map('map', { zoomControl: true }).setView(state.config.initialMap, state.config.initialZoom);

    const streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap'
    });
    const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: '© OpenTopoMap (CC-BY-SA)'
    });
    streets.addTo(state.map);
    L.control.layers({ 'Ruas': streets, 'Topográfico': topo }, {}, { position: 'topright' }).addTo(state.map);

    state.markers = L.layerGroup().addTo(state.map);
    state.map.on('click', (event) => {
      if (!state.pickOnMap) return;
      state.pickOnMap = false;
      el.pickMapButton.textContent = 'Escolher no mapa';
      el.pickMapButton.classList.remove('primary');
      const { lat, lng } = event.latlng;
      el.coordInput.value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
      runCalculation(lat, lng);
    });
  }

  async function loadDataset() {
    const [meta, sites] = await Promise.all([
      fetchJson(state.config.metaUrl, { cache: 'no-cache' }),
      fetchJson(state.config.datasetUrl, { cache: 'no-cache' })
    ]);

    if (!Array.isArray(sites)) throw new Error('O arquivo de sítios não contém uma lista válida.');
    state.meta = meta || {};
    state.sites = sites;

    populateUfFilter();
    renderDatasetStatus();

    if (sites.length === 0) {
      el.emptyState.innerHTML = '<strong>A base ainda não foi preenchida.</strong><span>Execute o workflow “Atualizar base SICG e publicar” no GitHub Actions ou rode o script de importação local descrito no LEIA-ME-PRIMEIRO.md.</span>';
    }
  }

  function initWorker() {
    state.worker = new Worker('./assets/js/distance-worker.js');
    state.worker.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'ready') {
        state.workerReady = true;
        return;
      }
      if (msg.type === 'result') {
        const pending = state.pendingRequests.get(msg.requestId);
        if (pending) {
          state.pendingRequests.delete(msg.requestId);
          pending.resolve(msg.values || []);
        }
      }
    };
    state.worker.onerror = (e) => console.error('Worker:', e);
    state.worker.postMessage({
      type: 'init',
      points: state.sites.map((s, i) => ({
        i,
        lon: Number(s.coordinates?.[0]),
        lat: Number(s.coordinates?.[1]),
        uf: s.uf || ''
      }))
    });
  }

  function populateUfFilter() {
    const ufs = [...new Set(state.sites.map(s => s.uf).filter(Boolean))].sort();
    for (const uf of ufs) {
      const option = document.createElement('option');
      option.value = uf;
      option.textContent = uf;
      el.ufFilter.appendChild(option);
    }
  }

  function renderDatasetStatus() {
    const m = state.meta || {};
    const total = Number(m.total_registros ?? state.sites.length).toLocaleString('pt-BR');
    const updated = formatDateTime(m.ultima_atualizacao_utc || m.ultima_consulta_utc);
    const photos = Number(m.com_fotografia ?? 0).toLocaleString('pt-BR');
    el.datasetStatus.innerHTML = `<strong>Base:</strong> ${total} registros · ${photos} com fotografia<br><strong>Atualização:</strong> ${escapeHtml(updated || 'não informada')}`;
  }

  function showDatasetError(error) {
    el.datasetStatus.innerHTML = `<strong>Falha ao carregar a base.</strong><br>${escapeHtml(error.message || String(error))}`;
    el.emptyState.innerHTML = '<strong>Não foi possível carregar os dados.</strong><span>Se estiver offline, abra novamente após uma visita online; se for a primeira publicação, execute a atualização inicial no GitHub Actions.</span>';
  }

  function parseCoordinateInput(value) {
    const text = String(value || '').trim();
    if (!text) return null;

    const decimal = text.match(/^\s*(-?\d{1,2}(?:[.,]\d+)?)\s*[,;]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*$/);
    if (decimal) {
      const lat = Number(decimal[1].replace(',', '.'));
      const lon = Number(decimal[2].replace(',', '.'));
      if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) return { lat, lon, kind: 'decimal' };
    }

    const utm = text.toUpperCase().replace(/,/g, '.').match(/^\s*(\d{1,2})([C-HJ-NP-X]|N|S)?\s+([0-9]+(?:\.\d+)?)\s+([0-9]+(?:\.\d+)?)\s*$/);
    if (utm) {
      const zone = Number(utm[1]);
      const suffix = utm[2] || '';
      const easting = Number(utm[3]);
      const northing = Number(utm[4]);
      if (zone < 1 || zone > 60) return null;

      let south = true;
      if (suffix === 'N') south = false;
      else if (suffix === 'S') south = true;
      else if (suffix) south = suffix.charCodeAt(0) < 'N'.charCodeAt(0);

      const src = `+proj=utm +zone=${zone} ${south ? '+south' : ''} +datum=WGS84 +units=m +no_defs`;
      const [lon, lat] = proj4(src, 'EPSG:4326', [easting, northing]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon, kind: 'utm' };
    }

    return null;
  }

  function calculateFromInput() {
    const parsed = parseCoordinateInput(el.coordInput.value);
    if (!parsed) {
      showToast('Formato de coordenadas inválido. Use latitude, longitude ou UTM, por exemplo: 23K 797000 7995000.');
      return;
    }
    runCalculation(parsed.lat, parsed.lon);
  }

  async function runCalculation(lat, lon) {
    if (!state.sites.length) {
      showToast('A base de sítios está vazia. Faça a atualização inicial antes da consulta.');
      return;
    }
    state.userLat = lat;
    state.userLon = lon;
    el.coordInput.value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    el.calculateButton.disabled = true;
    el.calculateButton.textContent = 'Calculando…';

    try {
      const radiusRaw = el.radiusInput.value.trim();
      const radiusKm = radiusRaw === '' ? null : Math.max(0, Number(radiusRaw));
      const uf = el.ufFilter.value;
      const values = await calculateDistances(lat, lon, radiusKm, uf);
      state.results = values.map(v => ({ site: state.sites[v.i], km: v.km }));
      state.page = 1;
      renderUserPoint();
      renderResults();
      if (radiusKm !== null && Number.isFinite(radiusKm)) renderRadius(radiusKm);
      else clearRadius();
    } catch (error) {
      console.error(error);
      showToast('Não foi possível concluir o cálculo de distâncias.');
    } finally {
      el.calculateButton.disabled = false;
      el.calculateButton.textContent = 'Calcular distâncias';
    }
  }

  function calculateDistances(lat, lon, radiusKm, uf) {
    if (!state.worker) return Promise.reject(new Error('Worker indisponível'));
    const requestId = ++state.requestSeq;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.pendingRequests.delete(requestId);
        reject(new Error('Tempo excedido no cálculo'));
      }, 30000);
      state.pendingRequests.set(requestId, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject
      });
      state.worker.postMessage({ type: 'calculate', requestId, lat, lon, radiusKm, uf });
    });
  }

  function renderResults() {
    const rowsPerPage = Number(state.config.rowsPerPage || 50);
    const total = state.results.length;
    const totalPages = Math.max(1, Math.ceil(total / rowsPerPage));
    state.page = Math.min(Math.max(1, state.page), totalPages);
    const start = (state.page - 1) * rowsPerPage;
    const pageItems = state.results.slice(start, start + rowsPerPage);
    const margin = Math.max(0, Number(el.marginInput.value) || 0);

    el.resultsBody.innerHTML = '';
    for (let offset = 0; offset < pageItems.length; offset++) {
      const entry = pageItems[offset];
      const site = entry.site;
      const meters = entry.km * 1000;
      const near = meters <= margin;
      const tr = document.createElement('tr');
      const sicgUrl = site.id_bem ? `${state.config.sicgDetailBaseUrl}${encodeURIComponent(site.id_bem)}` : '';
      tr.innerHTML = `
        <td data-label="#">${start + offset + 1}</td>
        <td data-label="IPHAN">${escapeHtml(site.co_iphan || '—')}</td>
        <td data-label="Sítio"><strong>${escapeHtml(site.identificacao_bem || 'Sem identificação')}</strong></td>
        <td data-label="Município/UF">${escapeHtml([site.municipio, site.uf].filter(Boolean).join(' / ') || '—')}</td>
        <td data-label="Distância" class="distance">${formatDistance(meters)}</td>
        <td data-label="Proximidade" class="${near ? 'proximity-yes' : 'proximity-no'}">${near ? `≤ ${margin} m` : 'Não'}</td>
        <td data-label="Ações"><div class="result-actions">
          <button class="button ghost compact" type="button" data-detail-key="${escapeAttr(siteKey(site))}">Ficha</button>
          ${sicgUrl ? `<a class="button secondary compact" href="${escapeAttr(sicgUrl)}" target="_blank" rel="noopener noreferrer">SICG</a>` : ''}
        </div></td>`;
      el.resultsBody.appendChild(tr);
    }

    el.resultsBody.querySelectorAll('[data-detail-key]').forEach(button => {
      button.addEventListener('click', () => openDetails(button.dataset.detailKey));
    });

    el.emptyState.hidden = total > 0;
    el.tableWrap.hidden = total === 0;
    el.pagination.hidden = total === 0;
    el.csvButton.disabled = total === 0;
    el.resultSummary.textContent = `${total.toLocaleString('pt-BR')} sítio(s) encontrados · ponto ${state.userLat.toFixed(6)}, ${state.userLon.toFixed(6)}`;
    renderPagination(totalPages);
    renderMapPage(pageItems);
  }

  function renderPagination(totalPages) {
    el.pagination.innerHTML = '';
    const prev = makeButton('Anterior', () => { state.page--; renderResults(); }, state.page <= 1);
    const info = document.createElement('span');
    info.textContent = `Página ${state.page} de ${totalPages}`;
    const next = makeButton('Próxima', () => { state.page++; renderResults(); }, state.page >= totalPages);
    el.pagination.append(prev, info, next);
  }

  function makeButton(label, onClick, disabled) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button ghost compact';
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener('click', onClick);
    return button;
  }

  function renderUserPoint() {
    if (state.userMarker) state.userMarker.setLatLng([state.userLat, state.userLon]);
    else {
      state.userMarker = L.circleMarker([state.userLat, state.userLon], {
        radius: 8, color: '#ffffff', weight: 3, fillColor: '#d73535', fillOpacity: 1
      }).addTo(state.map).bindPopup('<strong>Ponto da consulta</strong>');
    }
    state.map.setView([state.userLat, state.userLon], Math.max(state.map.getZoom(), 9));
  }

  function renderMapPage(pageItems) {
    state.markers.clearLayers();
    const bounds = L.latLngBounds([[state.userLat, state.userLon]]);
    for (const entry of pageItems) {
      const site = entry.site;
      const lon = Number(site.coordinates?.[0]);
      const lat = Number(site.coordinates?.[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const marker = L.circleMarker([lat, lon], {
        radius: 6, color: '#10251e', weight: 1, fillColor: '#d5ad42', fillOpacity: .95
      }).bindPopup(`<strong>${escapeHtml(site.identificacao_bem || 'Sítio arqueológico')}</strong><br>${escapeHtml(site.co_iphan || '')}<br>${formatDistance(entry.km * 1000)}`);
      marker.addTo(state.markers);
      bounds.extend([lat, lon]);
    }
    if (pageItems.length && bounds.isValid()) state.map.fitBounds(bounds, { padding: [28, 28], maxZoom: 12 });
  }

  function renderRadius(km) {
    clearRadius();
    state.radiusCircle = L.circle([state.userLat, state.userLon], {
      radius: km * 1000,
      color: '#67a7e8',
      weight: 2,
      fillOpacity: .06
    }).addTo(state.map);
  }

  function clearRadius() {
    if (state.radiusCircle) {
      state.map.removeLayer(state.radiusCircle);
      state.radiusCircle = null;
    }
  }

  async function openDetails(key) {
    const site = state.sites.find(s => siteKey(s) === key);
    if (!site) return;
    el.detailTitle.textContent = site.identificacao_bem || 'Sítio arqueológico';
    el.detailContent.innerHTML = '<p>Carregando detalhes…</p>';
    el.detailDialog.showModal();

    let fotografiasPromise = null;

function carregarFotografias() {
    if (!fotografiasPromise) {
        fotografiasPromise = fetchJson(
            './dados/fotografias_sicg.json'
        ).catch(error => {
            console.warn(
                'Base fotográfica indisponível:', error
            );

            fotografiasPromise = null;
            return {};
        });
    }

    return fotografiasPromise;
}
    

    try {
      if (!state.details) state.details = await fetchJson(state.config.detailsUrl, { cache: 'no-cache' });
      const detail = state.details[key] || {};
      const fotografias = await carregarFotografias();

const imageUrl =
    detail.imagem_url ||
    fotografias[String(site.id_bem)] ||
    '';
      el.detailContent.innerHTML = `
        <dl>
          <dt>Código IPHAN</dt><dd>${escapeHtml(site.co_iphan || '—')}</dd>
          <dt>ID SICG</dt><dd>${escapeHtml(site.id_bem ?? '—')}</dd>
          <dt>Município</dt><dd>${escapeHtml(site.municipio || '—')}</dd>
          <dt>UF</dt><dd>${escapeHtml(site.uf || '—')}</dd>
          <dt>Classificação</dt><dd>${escapeHtml(site.ds_classificacao || detail.ds_classificacao || '—')}</dd>
          <dt>Cadastro</dt><dd>${escapeHtml(site.dt_cadastro || '—')}</dd>
          <dt>Logradouro</dt><dd>${escapeHtml(detail.no_logradouro || '—')}</dd>
          <dt>Coordenadas</dt><dd>${escapeHtml(formatCoordinates(site.coordinates))}</dd>
        </dl>
        ${detail.sintese_bem ? `<div class="synthesis"><strong>Síntese</strong><br>${escapeHtml(detail.sintese_bem)}</div>` : ''}
        ${imageUrl ? `<img src="${escapeAttr(imageUrl)}" alt="Imagem associada ao registro do sítio" loading="lazy" referrerpolicy="no-referrer">` : ''}`;
    } catch (error) {
      console.error(error);
      el.detailContent.innerHTML = '<p>Os detalhes complementares não puderam ser carregados. O índice principal permanece disponível.</p>';
    }
  }

  function siteKey(site) {
    if (site?.id_bem !== null && site?.id_bem !== undefined && site.id_bem !== '') return String(site.id_bem);
    if (site?.co_iphan) return `co:${site.co_iphan}`;
    return `coord:${site?.coordinates?.join(',') || ''}:${site?.identificacao_bem || ''}`;
  }

  function useDeviceLocation() {
    if (!navigator.geolocation) {
      showToast('Este navegador não fornece geolocalização.');
      return;
    }
    el.useLocationButton.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        el.useLocationButton.disabled = false;
        const { latitude, longitude, accuracy } = pos.coords;
        el.coordInput.value = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
        showToast(`Localização obtida. Precisão informada pelo aparelho: ±${Math.round(accuracy)} m.`);
        runCalculation(latitude, longitude);
      },
      (err) => {
        el.useLocationButton.disabled = false;
        showToast(`Não foi possível obter a localização: ${err.message}`);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    );
  }

  function handleImageExif(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    el.imageStatus.textContent = 'Lendo metadados GPS…';

    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        if (!window.EXIF) {
          el.imageStatus.textContent = 'A biblioteca EXIF não foi carregada.';
          return;
        }
        EXIF.getData(img, function () {
          const latArr = EXIF.getTag(this, 'GPSLatitude');
          const lonArr = EXIF.getTag(this, 'GPSLongitude');
          const latRef = EXIF.getTag(this, 'GPSLatitudeRef');
          const lonRef = EXIF.getTag(this, 'GPSLongitudeRef');
          if (!latArr || !lonArr || !latRef || !lonRef) {
            el.imageStatus.textContent = 'A imagem não contém coordenadas GPS EXIF legíveis.';
            return;
          }
          const lat = dmsToDecimal(latArr, latRef);
          const lon = dmsToDecimal(lonArr, lonRef);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            el.imageStatus.textContent = 'Os metadados GPS foram encontrados, mas não puderam ser interpretados.';
            return;
          }
          el.coordInput.value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
          el.imageStatus.textContent = 'Coordenadas extraídas. A imagem não foi enviada para nenhum servidor.';
          runCalculation(lat, lon);
        });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function dmsToDecimal(values, ref) {
    const toNum = (v) => typeof v === 'number' ? v : (v?.numerator && v?.denominator ? v.numerator / v.denominator : Number(v));
    const d = toNum(values[0]);
    const m = toNum(values[1]);
    const s = toNum(values[2]);
    let out = d + m / 60 + s / 3600;
    if (String(ref).toUpperCase() === 'S' || String(ref).toUpperCase() === 'W') out *= -1;
    return out;
  }

  function exportCsv() {
    if (!state.results.length) return;
    const headers = ['ordem', 'id_bem', 'co_iphan', 'identificacao_bem', 'municipio', 'uf', 'longitude', 'latitude', 'distancia_m'];
    const lines = [headers.join(';')];
    state.results.forEach((entry, i) => {
      const s = entry.site;
      const row = [
        i + 1, s.id_bem ?? '', s.co_iphan ?? '', s.identificacao_bem ?? '', s.municipio ?? '', s.uf ?? '',
        s.coordinates?.[0] ?? '', s.coordinates?.[1] ?? '', (entry.km * 1000).toFixed(2)
      ];
      lines.push(row.map(csvCell).join(';'));
    });
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `proximetria_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function csvCell(value) {
    const text = String(value ?? '');
    return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`HTTP ${response.status} ao carregar ${url}`);
    return response.json();
  }

  function formatDistance(meters) {
    if (meters < 1000) return `${meters.toFixed(meters < 100 ? 1 : 0)} m`;
    return `${(meters / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 3 })} km`;
  }

  function formatCoordinates(coord) {
    if (!Array.isArray(coord) || coord.length < 2) return '—';
    return `${Number(coord[1]).toFixed(7)}, ${Number(coord[0]).toFixed(7)}`;
  }

  function formatDateTime(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Recife' }).format(d);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  }

  function escapeAttr(value) { return escapeHtml(value); }

  let toastTimer = null;
  function showToast(message) {
    clearTimeout(toastTimer);
    el.toast.textContent = message;
    el.toast.hidden = false;
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 4200);
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      await navigator.serviceWorker.register('./sw.js', { scope: './' });
    } catch (error) {
      console.warn('Service Worker não registrado:', error);
    }
  }
})();
