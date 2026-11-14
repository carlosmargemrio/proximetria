(() => {
  'use strict';

  const state = {
    config: null,
    sites: [],
    meta: null,
    details: null,
    detailsPromise: null,
    photos: null,
    photosPromise: null,
    photosUnavailable: false,
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
  const byId = id => document.getElementById(id);

  document.addEventListener('DOMContentLoaded', boot);

  // INICIALIZACAO

  async function boot() {
    cacheElements();
    initTheme();
    initNetworkStatus();
    initPwaInstall();
    bindEvents();

    try {
      state.config = await fetchJson('./config.json', {
        cache: 'no-cache'
      });

      await waitForLibraries();
      initMap();
      await loadDataset();
      initWorker();
      registerServiceWorker();

      carregarFotografias().then(renderDatasetStatus);

      console.info('ProxiMetria v1.0.4');

    } catch (error) {
      console.error(error);
      showDatasetError(error);
    }
  }

  function cacheElements() {
    const ids = [
      'networkBadge', 'installButton', 'themeButton',
      'coordInput', 'marginInput', 'radiusInput',
      'ufFilter', 'imageInput', 'imageStatus',
      'calculateButton', 'pickMapButton',
      'useLocationButton', 'datasetStatus',
      'resultSummary', 'emptyState', 'tableWrap',
      'resultsBody', 'pagination', 'csvButton',
      'detailDialog', 'detailTitle', 'detailContent',
      'toast', 'mapHint'
    ];

    ids.forEach(id => {
      el[id] = byId(id);
    });
  }

  function bindEvents() {
    el.themeButton.addEventListener('click', toggleTheme);
    el.calculateButton.addEventListener('click', calculateFromInput);

    el.coordInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') calculateFromInput();
    });

    el.pickMapButton.addEventListener('click', () => {
      state.pickOnMap = !state.pickOnMap;

      el.pickMapButton.textContent = state.pickOnMap
        ? 'Clique no mapa…'
        : 'Escolher no mapa';

      el.pickMapButton.classList.toggle('primary', state.pickOnMap);

      showToast(state.pickOnMap
        ? 'Clique no mapa para definir o ponto da consulta.'
        : 'Seleção no mapa cancelada.');
    });

    el.useLocationButton.addEventListener('click', useDeviceLocation);
    el.imageInput.addEventListener('change', handleImageExif);
    el.csvButton.addEventListener('click', exportCsv);

    el.ufFilter.addEventListener('change', () => {
      if (Number.isFinite(state.userLat) &&
          Number.isFinite(state.userLon)) {
        runCalculation(state.userLat, state.userLon);
      }
    });
  }

  // TEMA

  function initTheme() {
    const saved = localStorage.getItem('proximetria-theme');
    const preferred = window.matchMedia(
      '(prefers-color-scheme: light)'
    ).matches ? 'light' : 'dark';

    document.documentElement.dataset.theme = saved || preferred;
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'light'
      ? 'dark'
      : 'light';

    document.documentElement.dataset.theme = next;
    localStorage.setItem('proximetria-theme', next);
  }

  // CONEXAO

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

  // INSTALACAO PWA

  function initPwaInstall() {
    window.addEventListener('beforeinstallprompt', event => {
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

    while ((!window.L || !window.proj4) &&
           Date.now() - started < 10000) {
      await new Promise(r => setTimeout(r, 60));
    }

    if (!window.L) {
      throw new Error('Leaflet não foi carregado.');
    }

    if (!window.proj4) {
      throw new Error('Proj4 não foi carregado.');
    }
  }

  // MAPA

  function initMap() {
    state.map = L.map('map', {
      zoomControl: true
    }).setView(
      state.config.initialMap,
      state.config.initialZoom
    );

    const streets = L.tileLayer(
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
      }
    );

    const topo = L.tileLayer(
      'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      {
        maxZoom: 17,
        attribution: '© OpenTopoMap (CC-BY-SA)'
      }
    );

    streets.addTo(state.map);

    L.control.layers(
      { 'Ruas': streets, 'Topográfico': topo },
      {},
      { position: 'topright' }
    ).addTo(state.map);

    state.markers = L.layerGroup().addTo(state.map);

    state.map.on('click', event => {
      if (!state.pickOnMap) return;

      state.pickOnMap = false;
      el.pickMapButton.textContent = 'Escolher no mapa';
      el.pickMapButton.classList.remove('primary');

      const { lat, lng } = event.latlng;

      el.coordInput.value =
        `${lat.toFixed(6)}, ${lng.toFixed(6)}`;

      runCalculation(lat, lng);
    });
  }

  // BASE DE DADOS

  async function loadDataset() {
    const [meta, sites] = await Promise.all([
      fetchJson(state.config.metaUrl, { cache: 'no-cache' }),
      fetchJson(state.config.datasetUrl, { cache: 'no-cache' })
    ]);

    if (!Array.isArray(sites)) {
      throw new Error('O arquivo de sítios não contém uma lista válida.');
    }

    state.meta = meta || {};
    state.sites = sites;

    populateUfFilter();
    renderDatasetStatus();

    if (!sites.length) {
      el.emptyState.innerHTML =
        '<strong>A base ainda não foi preenchida.</strong>' +
        '<span>Execute a atualização inicial no GitHub Actions.</span>';
    }
  }

  function populateUfFilter() {
    const ufs = [
      ...new Set(state.sites.map(s => s.uf).filter(Boolean))
    ].sort();

    for (const uf of ufs) {
      const option = document.createElement('option');
      option.value = uf;
      option.textContent = uf;
      el.ufFilter.appendChild(option);
    }
  }

  function renderDatasetStatus() {
    const m = state.meta || {};

    const total = Number(
      m.total_registros ?? state.sites.length
    ).toLocaleString('pt-BR');

    const updated = formatDateTime(
      m.ultima_atualizacao_utc || m.ultima_consulta_utc
    );

    const count = state.photos
      ? state.sites.filter(s =>
          s.tem_foto === true ||
          Boolean(state.photos[String(s.id_bem).trim()])
        ).length
      : Number(m.com_fotografia ?? 0);

    const note = state.photosUnavailable
      ? ' (base complementar indisponível)'
      : '';

    el.datasetStatus.innerHTML = `
      <strong>Base:</strong> ${total} registros ·
      ${count.toLocaleString('pt-BR')} com referência fotográfica${note}
      <br>
      <strong>Atualização:</strong>
      ${escapeHtml(updated || 'não informada')}
    `;
  }

  function showDatasetError(error) {
    el.datasetStatus.innerHTML = `
      <strong>Falha ao carregar a base.</strong><br>
      ${escapeHtml(error.message || String(error))}
    `;

    el.emptyState.innerHTML = `
      <strong>Não foi possível carregar os dados.</strong>
      <span>Verifique a conexão ou a atualização inicial da base.</span>
    `;
  }

  // WEB WORKER

  function initWorker() {
    state.worker = new Worker('./assets/js/distance-worker.js');

    state.worker.onmessage = event => {
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

    state.worker.onerror = e => console.error('Worker:', e);

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

  // COORDENADAS

  function parseCoordinateInput(value) {
    const text = String(value || '').trim();
    if (!text) return null;

    const decimal = text.match(
      /^\s*(-?\d{1,2}(?:[.,]\d+)?)\s*[,;]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*$/
    );

    if (decimal) {
      const lat = Number(decimal[1].replace(',', '.'));
      const lon = Number(decimal[2].replace(',', '.'));

      if (lat >= -90 && lat <= 90 &&
          lon >= -180 && lon <= 180) {
        return { lat, lon, kind: 'decimal' };
      }
    }

    const utm = text.toUpperCase().replace(/,/g, '.').match(
      /^\s*(\d{1,2})([C-HJ-NP-X]|N|S)?\s+([0-9]+(?:\.\d+)?)\s+([0-9]+(?:\.\d+)?)\s*$/
    );

    if (utm) {
      const zone = Number(utm[1]);
      const suffix = utm[2] || '';
      const easting = Number(utm[3]);
      const northing = Number(utm[4]);

      if (zone < 1 || zone > 60) return null;

      let south = true;

      if (suffix === 'N') south = false;
      else if (suffix === 'S') south = true;
      else if (suffix) {
        south = suffix.charCodeAt(0) < 'N'.charCodeAt(0);
      }

      const src =
        `+proj=utm +zone=${zone} ${south ? '+south' : ''} ` +
        '+datum=WGS84 +units=m +no_defs';

      const [lon, lat] = proj4(
        src,
        'EPSG:4326',
        [easting, northing]
      );

      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        return { lat, lon, kind: 'utm' };
      }
    }

    return null;
  }

  function calculateFromInput() {
    const parsed = parseCoordinateInput(el.coordInput.value);

    if (!parsed) {
      showToast(
        'Formato inválido. Use latitude, longitude ou UTM, ' +
        'por exemplo: 23K 797000 7995000.'
      );
      return;
    }

    runCalculation(parsed.lat, parsed.lon);
  }

  // CALCULO DE DISTANCIAS

  async function runCalculation(lat, lon) {
    if (!state.sites.length) {
      showToast('A base de sítios está vazia.');
      return;
    }

    state.userLat = lat;
    state.userLon = lon;

    el.coordInput.value =
      `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

    el.calculateButton.disabled = true;
    el.calculateButton.textContent = 'Calculando…';

    try {
      const radiusRaw = el.radiusInput.value.trim();

      const radiusKm = radiusRaw === ''
        ? null
        : Math.max(0, Number(radiusRaw));

      const uf = el.ufFilter.value;

      const values = await calculateDistances(
        lat, lon, radiusKm, uf
      );

      state.results = values.map(v => ({
        site: state.sites[v.i],
        km: v.km
      }));

      state.page = 1;

      renderUserPoint();
      renderResults();

      if (radiusKm !== null && Number.isFinite(radiusKm)) {
        renderRadius(radiusKm);
      } else {
        clearRadius();
      }

    } catch (error) {
      console.error(error);
      showToast('Não foi possível concluir o cálculo.');

    } finally {
      el.calculateButton.disabled = false;
      el.calculateButton.textContent = 'Calcular distâncias';
    }
  }

  function calculateDistances(lat, lon, radiusKm, uf) {
    if (!state.worker) {
      return Promise.reject(new Error('Worker indisponível'));
    }

    const requestId = ++state.requestSeq;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.pendingRequests.delete(requestId);
        reject(new Error('Tempo excedido no cálculo'));
      }, 30000);

      state.pendingRequests.set(requestId, {
        resolve: value => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject
      });

      state.worker.postMessage({
        type: 'calculate',
        requestId,
        lat,
        lon,
        radiusKm,
        uf
      });
    });
  }

  // RESULTADOS

  function renderResults() {
    const rowsPerPage = Number(state.config.rowsPerPage || 50);
    const total = state.results.length;
    const totalPages = Math.max(1, Math.ceil(total / rowsPerPage));

    state.page = Math.min(Math.max(1, state.page), totalPages);

    const start = (state.page - 1) * rowsPerPage;
    const pageItems = state.results.slice(start, start + rowsPerPage);
    const margin = Math.max(0, Number(el.marginInput.value) || 0);

    el.resultsBody.innerHTML = '';

    pageItems.forEach((entry, offset) => {
      const site = entry.site;
      const meters = entry.km * 1000;
      const near = meters <= margin;
      const tr = document.createElement('tr');

      const sicgUrl = site.id_bem
        ? `${state.config.sicgDetailBaseUrl}${encodeURIComponent(site.id_bem)}`
        : '';

      tr.innerHTML = `
        <td data-label="#">${start + offset + 1}</td>
        <td data-label="IPHAN">${escapeHtml(site.co_iphan || '—')}</td>
        <td data-label="Sítio">
          <strong>${escapeHtml(site.identificacao_bem || 'Sem identificação')}</strong>
        </td>
        <td data-label="Município/UF">
          ${escapeHtml([site.municipio, site.uf].filter(Boolean).join(' / ') || '—')}
        </td>
        <td data-label="Distância" class="distance">
          ${formatDistance(meters)}
        </td>
        <td data-label="Proximidade"
            class="${near ? 'proximity-yes' : 'proximity-no'}">
          ${near ? `≤ ${margin} m` : 'Não'}
        </td>
        <td data-label="Ações">
          <div class="result-actions">
            <button class="button ghost compact"
                    type="button"
                    data-detail-key="${escapeAttr(siteKey(site))}">
              Ficha
            </button>
            ${sicgUrl ? `
              <a class="button secondary compact"
                 href="${escapeAttr(sicgUrl)}"
                 target="_blank"
                 rel="noopener noreferrer">SICG</a>
            ` : ''}
          </div>
        </td>
      `;

      el.resultsBody.appendChild(tr);
    });

    el.resultsBody.querySelectorAll('[data-detail-key]').forEach(button => {
      button.addEventListener('click', () => {
        openDetails(button.dataset.detailKey);
      });
    });

    el.emptyState.hidden = total > 0;
    el.tableWrap.hidden = total === 0;
    el.pagination.hidden = total === 0;
    el.csvButton.disabled = total === 0;

    el.resultSummary.textContent =
      `${total.toLocaleString('pt-BR')} sítio(s) encontrados · ` +
      `ponto ${state.userLat.toFixed(6)}, ${state.userLon.toFixed(6)}`;

    renderPagination(totalPages);
    renderMapPage(pageItems);
  }

  function renderPagination(totalPages) {
    el.pagination.innerHTML = '';

    const prev = makeButton('Anterior', () => {
      state.page--;
      renderResults();
    }, state.page <= 1);

    const next = makeButton('Próxima', () => {
      state.page++;
      renderResults();
    }, state.page >= totalPages);

    const info = document.createElement('span');
    info.textContent = `Página ${state.page} de ${totalPages}`;

    el.pagination.append(prev, info, next);
  }

  function makeButton(label, onClick, disabled = false) {
    const button = document.createElement('button');

    button.type = 'button';
    button.className = 'button ghost compact';
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener('click', onClick);

    return button;
  }

  // PONTO DE CONSULTA

  function renderUserPoint() {
    const point = [state.userLat, state.userLon];

    if (state.userMarker) {
      state.userMarker.setLatLng(point);
    } else {
      state.userMarker = L.circleMarker(point, {
        radius: 8,
        color: '#ffffff',
        weight: 3,
        fillColor: '#d73535',
        fillOpacity: 1
      }).addTo(state.map)
        .bindPopup('<strong>Ponto da consulta</strong>');
    }

    state.map.setView(point, Math.max(state.map.getZoom(), 9));
  }

  // POPUPS COM FOTOGRAFIA E SINTESE

  function renderMapPage(pageItems) {
    state.markers.clearLayers();

    const bounds = L.latLngBounds([
      [state.userLat, state.userLon]
    ]);

    for (const entry of pageItems) {
      const site = entry.site;
      const [lon, lat] = (site.coordinates || []).map(Number);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const key = siteKey(site);

      const marker = L.circleMarker([lat, lon], {
        radius: 6,
        color: '#10251e',
        weight: 1,
        fillColor: '#d5ad42',
        fillOpacity: .95
      });

      const popup = document.createElement('div');
      popup.className = 'pm-popup';

      popup.innerHTML = `
        <strong>${escapeHtml(site.identificacao_bem || 'Sítio arqueológico')}</strong>
        <br>${escapeHtml(site.co_iphan || '')}
        <br>${formatDistance(entry.km * 1000)}
      `;

      const photoSlot = document.createElement('div');

      const summary = document.createElement('div');
      summary.className = 'pm-popup-sintese';

      popup.append(
        photoSlot,
        summary,
        makeButton('Ficha completa', () => openDetails(key))
      );

      marker.bindPopup(popup, {
        maxWidth: 300,
        maxHeight: 380
      });

      let generation = 0;

      marker.on('popupopen', () => {
        const token = ++generation;

        const active = () =>
          token === generation && marker.isPopupOpen();

        const update = () => {
          if (active()) marker.getPopup()?.update();
        };

        let shown = false;

        photoSlot.replaceChildren();
        summary.textContent = 'Carregando síntese…';

        const showPhoto = value => {
          const url = normalizarFoto(value);

          if (!active() || shown || !url) return;

          shown = true;
          exibirFoto(photoSlot, url, true, update);
          update();
        };

        const id = String(site.id_bem ?? '').trim();

        showPhoto(
          normalizarFoto(state.details?.[key]?.imagem_url) ||
          state.photos?.[id]
        );

        carregarFotografias().then(photos => {
          showPhoto(photos[id]);
        });

        carregarDetalhes().then(data => {
          if (!active()) return;

          const detail = data?.[key] || {};

          const text = String(detail.sintese_bem || '')
            .replace(/\s+/g, ' ')
            .trim();

          const preview = text.length > 220
            ? text.slice(0, 220).trimEnd() + '…'
            : text;

          summary.innerHTML =
            `<strong>Síntese</strong>${escapeHtml(preview || 'Não informada pelo SICG.')}`;

          showPhoto(detail.imagem_url);
          update();

        }).catch(() => {
          if (active()) {
            summary.textContent = 'Síntese indisponível.';
            update();
          }
        });
      });

      marker.on('popupclose', () => {
        generation++;
      });

      marker.addTo(state.markers);
      bounds.extend([lat, lon]);
    }

    if (pageItems.length && bounds.isValid()) {
      state.map.fitBounds(bounds, {
        padding: [28, 28],
        maxZoom: 12
      });
    }
  }

  // RAIO

  function renderRadius(km) {
    clearRadius();

    state.radiusCircle = L.circle(
      [state.userLat, state.userLon],
      {
        radius: km * 1000,
        color: '#67a7e8',
        weight: 2,
        fillOpacity: .06
      }
    ).addTo(state.map);
  }

  function clearRadius() {
    if (state.radiusCircle) {
      state.map.removeLayer(state.radiusCircle);
      state.radiusCircle = null;
    }
  }

  // BASE FOTOGRAFICA

  function normalizarFoto(value) {
    if (typeof value !== 'string' || !value.trim()) return '';

    try {
      const url = new URL(value.trim());

      if (!['http:', 'https:'].includes(url.protocol) ||
          url.hostname !== 'sicg.iphan.gov.br' ||
          url.href.toLowerCase().includes('help.gif')) {
        return '';
      }

      url.protocol = 'https:';
      return url.href;

    } catch {
      return '';
    }
  }

  function carregarFotografias() {
    if (state.photos) return Promise.resolve(state.photos);
    if (state.photosPromise) return state.photosPromise;

    state.photosPromise = fetchJson(
      './dados/fotografias_sicg.json',
      { cache: 'no-cache' }
    ).then(raw => {
      if (!raw || typeof raw !== 'object') {
        throw new Error('Formato da base fotográfica inválido');
      }

      const photos = Object.create(null);

      const entries = Array.isArray(raw)
        ? raw.map(r => [
            r?.id ?? r?.id_bem,
            r?.img ?? r?.imagem_url
          ])
        : Object.entries(raw);

      for (const [id, value] of entries) {
        const url = normalizarFoto(
          typeof value === 'string'
            ? value
            : value?.img ?? value?.imagem_url
        );

        if (id != null && String(id).trim() && url) {
          photos[String(id).trim()] = url;
        }
      }

      state.photos = photos;
      state.photosUnavailable = false;

      renderDatasetStatus();

      console.info(
        '[ProxiMetria] Referências fotográficas:',
        Object.keys(photos).length
      );

      return photos;

    }).catch(error => {
      state.photosUnavailable = true;
      console.warn('Base fotográfica indisponível:', error);
      return Object.create(null);

    }).finally(() => {
      state.photosPromise = null;
    });

    return state.photosPromise;
  }

  function carregarDetalhes() {
    if (state.details) return Promise.resolve(state.details);

    if (!state.detailsPromise) {
      state.detailsPromise = fetchJson(
        state.config.detailsUrl,
        { cache: 'no-cache' }
      ).then(data => {
        state.details = data;
        return data;

      }).finally(() => {
        state.detailsPromise = null;
      });
    }

    return state.detailsPromise;
  }

  async function obterFoto(site, detail = {}) {
    const official = normalizarFoto(detail.imagem_url);
    if (official) return official;

    const photos = await carregarFotografias();

    return photos[String(site.id_bem ?? '').trim()] || '';
  }

  // FOTOGRAFIA DO POPUP

  function exibirFoto(container, url, compact = false, onLayout = () => {}) {
    if (!container || !url) return;

    container.replaceChildren();

    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Abrir fotografia no SICG';
    link.style.display = 'block';

    const img = document.createElement('img');

    img.alt = 'Fotografia associada ao registro do sítio';
    img.decoding = 'async';

    img.style.cssText = `
      display:block;
      max-width:100%;
      max-height:${compact ? '140px' : '380px'};
      width:auto;
      height:auto;
      object-fit:contain;
      border-radius:6px;
      margin:8px auto;
    `;

    img.addEventListener('load', onLayout, { once: true });

    img.addEventListener('error', () => {
      img.remove();

      const note = document.createElement('small');
      note.textContent = 'Fotografia indisponível.';

      container.prepend(note);
      onLayout();

    }, { once: true });

    container.append(img, link);
    img.src = url;
  }

  // FICHA ARQUEOLOGICA RESPONSIVA V1.0.4

  async function openDetails(key) {
    const site = state.sites.find(s => siteKey(s) === key);
    if (!site) return;

    el.detailTitle.textContent =
      site.identificacao_bem || 'Sítio arqueológico';

    el.detailContent.innerHTML = `
      <div class="pm-ficha">
        <div class="pm-topo">
          <dl class="pm-campos"></dl>
          <figure class="pm-foto">
            <div class="pm-foto-quadro" aria-live="polite">
              <small>Consultando fotografia…</small>
            </div>
            <a hidden target="_blank" rel="noopener noreferrer">
              Abrir fotografia original ↗
            </a>
          </figure>
        </div>
        <div class="pm-sintese">
          <strong>Síntese</strong>
          <div class="pm-sintese-texto" tabindex="0">
            Carregando síntese…
          </div>
        </div>
      </div>
    `;

    const root = el.detailContent.querySelector('.pm-ficha');
    const top = root.querySelector('.pm-topo');
    const fields = root.querySelector('.pm-campos');
    const figure = root.querySelector('.pm-foto');
    const frame = figure.querySelector('.pm-foto-quadro');
    const link = figure.querySelector('a');
    const synthesis = root.querySelector('.pm-sintese-texto');

    const active = () =>
      root.isConnected && el.detailDialog.open;

    const id = String(site.id_bem ?? '').trim();

    let detail = state.details?.[key] || {};
    let displayedUrl = '';

    function renderFields() {
      const rows = [
        ['Código IPHAN', site.co_iphan],
        ['ID SICG', site.id_bem],
        ['Município', site.municipio || detail.municipio],
        ['UF', site.uf],
        ['Classificação', site.ds_classificacao || detail.ds_classificacao],
        ['Cadastro', site.dt_cadastro],
        ['Logradouro', detail.no_logradouro],
        ['Coordenadas', formatCoordinates(site.coordinates)]
      ];

      fields.innerHTML = rows.map(([label, value]) =>
        `<dt>${escapeHtml(label)}</dt>` +
        `<dd>${escapeHtml(value ?? '—') || '—'}</dd>`
      ).join('');
    }

    function showPhoto(value) {
      const url = normalizarFoto(value);

      if (!active() || !url || displayedUrl) return;

      displayedUrl = url;
      link.href = url;
      link.hidden = false;

      const status = document.createElement('small');
      status.textContent = 'Carregando fotografia…';

      frame.replaceChildren(status);

      const img = new Image();

      img.alt = 'Fotografia associada ao registro do sítio';
      img.decoding = 'async';

      img.addEventListener('load', () => {
        if (active()) {
          frame.replaceChildren(img);
        }
      }, { once: true });

      img.addEventListener('error', () => {
        if (active()) {
          status.textContent =
            'Fotografia indisponível. Abra o link original.';
        }
      }, { once: true });

      img.src = url;
    }

    renderFields();

    if (!el.detailDialog.open) {
      el.detailDialog.showModal();
    }

    el.detailContent.scrollTop = 0;

    // Utiliza imediatamente a fotografia em memória

    showPhoto(
      normalizarFoto(detail.imagem_url) ||
      state.photos?.[id]
    );

    // Consulta dos detalhes sem bloquear a fotografia

    const detailsTask = carregarDetalhes().then(data => {
      if (!active()) return;

      detail = data?.[key] || {};

      renderFields();

      synthesis.textContent =
        String(detail.sintese_bem || '').trim() ||
        'Síntese não informada pelo SICG.';

      showPhoto(detail.imagem_url);

    }).catch(() => {
      if (active()) {
        synthesis.textContent =
          'Não foi possível carregar a síntese.';
      }
    });

    // Consulta independente da base fotográfica

    const photosTask = carregarFotografias().then(photos => {
      showPhoto(photos[id]);
    });

    await Promise.allSettled([
      detailsTask,
      photosTask
    ]);

    // Sem fotografia, os campos ocupam toda a largura

    if (active() && !displayedUrl) {
      if (state.photosUnavailable) {
        frame.textContent = 'Base fotográfica indisponível.';
      } else {
        figure.hidden = true;
        top.classList.add('sem-foto');
      }
    }
  }

  // IDENTIFICADOR

  function siteKey(site) {
    if (site?.id_bem !== null &&
        site?.id_bem !== undefined &&
        site.id_bem !== '') {
      return String(site.id_bem);
    }

    if (site?.co_iphan) return `co:${site.co_iphan}`;

    return `coord:${site?.coordinates?.join(',') || ''}:${site?.identificacao_bem || ''}`;
  }

  // GEOLOCALIZACAO

  function useDeviceLocation() {
    if (!navigator.geolocation) {
      showToast('Este navegador não fornece geolocalização.');
      return;
    }

    el.useLocationButton.disabled = true;

    navigator.geolocation.getCurrentPosition(pos => {
      el.useLocationButton.disabled = false;

      const { latitude, longitude, accuracy } = pos.coords;

      el.coordInput.value =
        `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;

      showToast(
        `Localização obtida. Precisão: ±${Math.round(accuracy)} m.`
      );

      runCalculation(latitude, longitude);

    }, err => {
      el.useLocationButton.disabled = false;
      showToast(`Não foi possível obter a localização: ${err.message}`);

    }, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 30000
    });
  }

  // EXIF

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
            el.imageStatus.textContent =
              'A imagem não contém coordenadas GPS EXIF legíveis.';
            return;
          }

          const lat = dmsToDecimal(latArr, latRef);
          const lon = dmsToDecimal(lonArr, lonRef);

          if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            el.imageStatus.textContent =
              'Não foi possível interpretar as coordenadas.';
            return;
          }

          el.coordInput.value =
            `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

          el.imageStatus.textContent =
            'Coordenadas extraídas. A imagem não foi enviada para nenhum servidor.';

          runCalculation(lat, lon);
        });
      };

      img.src = reader.result;
    };

    reader.readAsDataURL(file);
  }

  function dmsToDecimal(values, ref) {
    const toNum = v => typeof v === 'number'
      ? v
      : v?.numerator && v?.denominator
        ? v.numerator / v.denominator
        : Number(v);

    const d = toNum(values[0]);
    const m = toNum(values[1]);
    const s = toNum(values[2]);

    let out = d + m / 60 + s / 3600;

    if (['S', 'W'].includes(String(ref).toUpperCase())) {
      out *= -1;
    }

    return out;
  }

  // CSV

  function exportCsv() {
    if (!state.results.length) return;

    const headers = [
      'ordem', 'id_bem', 'co_iphan', 'identificacao_bem',
      'municipio', 'uf', 'longitude', 'latitude', 'distancia_m'
    ];

    const lines = [headers.join(';')];

    state.results.forEach((entry, i) => {
      const s = entry.site;

      lines.push([
        i + 1,
        s.id_bem ?? '',
        s.co_iphan ?? '',
        s.identificacao_bem ?? '',
        s.municipio ?? '',
        s.uf ?? '',
        s.coordinates?.[0] ?? '',
        s.coordinates?.[1] ?? '',
        (entry.km * 1000).toFixed(2)
      ].map(csvCell).join(';'));
    });

    const blob = new Blob(
      ['\ufeff' + lines.join('\n')],
      { type: 'text/csv;charset=utf-8;' }
    );

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    a.href = url;
    a.download = `proximetria_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();

    URL.revokeObjectURL(url);
  }

  function csvCell(value) {
    const text = String(value ?? '');

    return /[;"\n]/.test(text)
      ? `"${text.replace(/"/g, '""')}"`
      : text;
  }

  // FUNCOES AUXILIARES

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ao carregar ${url}`);
    }

    return response.json();
  }

  function formatDistance(meters) {
    if (meters < 1000) {
      return `${meters.toFixed(meters < 100 ? 1 : 0)} m`;
    }

    return `${(meters / 1000).toLocaleString('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 3
    })} km`;
  }

  function formatCoordinates(coord) {
    if (!Array.isArray(coord) || coord.length < 2) return '—';

    return `${Number(coord[1]).toFixed(7)}, ${Number(coord[0]).toFixed(7)}`;
  }

  function formatDateTime(value) {
    if (!value) return '';

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return String(value);

    return new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: 'America/Recife'
    }).format(date);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[c]));
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  let toastTimer = null;

  function showToast(message) {
    clearTimeout(toastTimer);

    el.toast.textContent = message;
    el.toast.hidden = false;

    toastTimer = setTimeout(() => {
      el.toast.hidden = true;
    }, 4200);
  }

  // SERVICE WORKER

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    try {
      await navigator.serviceWorker.register('./sw.js', {
        scope: './'
      });
    } catch (error) {
      console.warn('Service Worker não registrado:', error);
    }
  }

})();
