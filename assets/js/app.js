(() => {
  'use strict';

  const VERSION = '1.0.7';

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
    mode: null,
    searchText: '',
    userLat: null,
    userLon: null,
    worker: null,
    workerReady: false,
    pendingRequests: new Map(),
    requestSeq: 0,
    querySeq: 0,
    imageSeq: 0,
    pickOnMap: false,
    deferredInstall: null
  };

  const el = {};
  const byId = id => document.getElementById(id);

  document.addEventListener('DOMContentLoaded', boot);

  // ==========================================
  // INICIALIZACAO
  // ==========================================

  async function boot() {
    cacheElements();
    configureInterface();
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

      console.info(`ProxiMetria v${VERSION}`);

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

  function configureInterface() {
    const field = el.coordInput.closest('.field');

    const label = field?.querySelector('span');
    const help = field?.querySelector('small');

    if (label) {
      label.textContent = 'Coordenadas ou pesquisa';
    }

    if (help) {
      help.textContent =
        'Informe coordenadas decimais, UTM, nome do sítio, ' +
        'município, código IPHAN ou ID SICG.';
    }

    el.coordInput.placeholder =
      'Coordenadas, sítio ou município';

    el.coordInput.spellcheck = false;

    el.calculateButton.textContent = 'Pesquisar / calcular';

    // Permite selecionar o arquivo original pelo gerenciador
    // de arquivos, sem restringir ao seletor de fotografias.

    el.imageInput.removeAttribute('accept');

    el.imageStatus.textContent =
      'Selecione a fotografia original. No celular, prefira ' +
      'o gerenciador Arquivos. A imagem não será enviada.';
  }

  function bindEvents() {
    el.themeButton.addEventListener('click', toggleTheme);

    el.calculateButton.addEventListener(
      'click', calculateFromInput
    );

    el.coordInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        calculateFromInput();
      }
    });

    el.pickMapButton.addEventListener('click', () => {
      state.pickOnMap = !state.pickOnMap;

      el.pickMapButton.textContent = state.pickOnMap
        ? 'Clique no mapa…'
        : 'Escolher no mapa';

      el.pickMapButton.classList.toggle(
        'primary', state.pickOnMap
      );

      showToast(state.pickOnMap
        ? 'Clique no mapa para definir o ponto da consulta.'
        : 'Seleção no mapa cancelada.');
    });

    el.useLocationButton.addEventListener(
      'click', useDeviceLocation
    );

    el.imageInput.addEventListener(
      'change', handleImageExif
    );

    el.imageInput.addEventListener('click', () => {
      el.imageInput.value = '';
    });

    el.csvButton.addEventListener('click', exportCsv);

    el.ufFilter.addEventListener('change', () => {
      if (state.mode === 'text') {
        runTextSearch(state.searchText);
      } else if (validPoint(state.userLat, state.userLon)) {
        runCalculation(state.userLat, state.userLon);
      }
    });
  }

  // ==========================================
  // TEMA E CONEXAO
  // ==========================================

  function initTheme() {
    const saved = localStorage.getItem('proximetria-theme');

    const preferred = window.matchMedia(
      '(prefers-color-scheme: light)'
    ).matches ? 'light' : 'dark';

    document.documentElement.dataset.theme = saved || preferred;
  }

  function toggleTheme() {
    const next =
      document.documentElement.dataset.theme === 'light'
        ? 'dark' : 'light';

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

  // ==========================================
  // MAPA
  // ==========================================

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

      resetMapPick();

      const { lat, lng } = event.latlng;
      runCalculation(lat, lng);
    });
  }

  function resetMapPick() {
    state.pickOnMap = false;
    el.pickMapButton.textContent = 'Escolher no mapa';
    el.pickMapButton.classList.remove('primary');
  }

  function validPoint(lat, lon) {
    return Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      lat >= -90 && lat <= 90 &&
      lon >= -180 && lon <= 180;
  }

  function sitePoint(site) {
    const coord = site?.coordinates;

    if (!Array.isArray(coord) || coord.length < 2) {
      return null;
    }

    if (coord[0] == null || coord[1] == null ||
        coord[0] === '' || coord[1] === '') {
      return null;
    }

    const lon = Number(coord[0]);
    const lat = Number(coord[1]);

    return validPoint(lat, lon) ? { lat, lon } : null;
  }

  // ==========================================
  // BASE NACIONAL
  // ==========================================

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
      ${count.toLocaleString('pt-BR')}
      com referência fotográfica${note}
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

    el.emptyState.innerHTML =
      '<strong>Não foi possível carregar os dados.</strong>' +
      '<span>Verifique a conexão ou a atualização da base.</span>';
  }

  // ==========================================
  // WEB WORKER
  // ==========================================

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

    state.worker.onerror = error => {
      console.error('Worker:', error);
    };

    state.worker.postMessage({
      type: 'init',
      points: state.sites.map((site, i) => {
        const point = sitePoint(site);

        return {
          i,
          lat: point?.lat ?? NaN,
          lon: point?.lon ?? NaN,
          uf: site.uf || ''
        };
      })
    });
  }

  // ==========================================
  // INTERPRETACAO DE COORDENADAS
  // ==========================================

  function parseCoordinateInput(value) {
    const text = String(value || '')
      .replace(/[−–—]/g, '-')
      .trim();

    if (!text) return null;

    // Latitude e longitude separadas por vírgula,
    // ponto e vírgula ou espaço.

    const decimal = text.match(
      /^([+-]?\d{1,3}(?:[.,]\d+)?)\s*[,;]\s*([+-]?\d{1,3}(?:[.,]\d+)?)$/
    ) || text.match(
      /^([+-]?\d{1,3}(?:[.,]\d+)?)\s+([+-]?\d{1,3}(?:[.,]\d+)?)$/
    );

    if (decimal) {
      const lat = Number(decimal[1].replace(',', '.'));
      const lon = Number(decimal[2].replace(',', '.'));

      if (validPoint(lat, lon)) {
        return { lat, lon, kind: 'decimal' };
      }

      return null;
    }

    // Coordenadas UTM.

    const utm = text.toUpperCase().replace(/,/g, '.').match(
      /^(\d{1,2})([C-HJ-NP-X])?\s+([0-9]+(?:\.\d+)?)\s+([0-9]+(?:\.\d+)?)$/
    );

    if (utm) {
      const zone = Number(utm[1]);
      const suffix = utm[2] || '';
      const easting = Number(utm[3]);
      const northing = Number(utm[4]);

      if (zone < 1 || zone > 60 ||
          easting < 100000 || easting > 900000 ||
          northing < 0 || northing > 10000000) {
        return null;
      }

      let south = true;

      if (suffix === 'N') {
        south = false;
      } else if (suffix === 'S') {
        south = true;
      } else if (suffix) {
        south = suffix.charCodeAt(0) < 'N'.charCodeAt(0);
      }

      const src =
        `+proj=utm +zone=${zone} ${south ? '+south' : ''} ` +
        '+datum=WGS84 +units=m +no_defs';

      try {
        const [lon, lat] = proj4(
          src, 'EPSG:4326', [easting, northing]
        );

        if (validPoint(lat, lon)) {
          return { lat, lon, kind: 'utm' };
        }

      } catch (error) {
        console.warn('Conversão UTM:', error);
      }
    }

    return null;
  }

  function looksLikeCoordinates(value) {
    const text = String(value).trim();

    if (/^\d+$/.test(text)) return false;

    return /^[+\-−–—\d.,;\s]+$/.test(text) ||
      /^\d{1,2}[a-z]?\s+[\d.,]+\s+[\d.,]+$/i.test(text);
  }

  // ==========================================
  // PESQUISA TEXTUAL
  // ==========================================

  function norm(value) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ');
  }

  function municipio(site, detail = {}) {
    return site.municipio ||
      site.municipio_cadastral ||
      detail.municipio ||
      detail.municipio_cadastral ||
      site.municipio_espacial ||
      '';
  }

  function matchesSite(site, query) {
    const q = norm(query);
    const name = norm(site.identificacao_bem);

    const places = [
      site.municipio,
      site.municipio_cadastral,
      site.municipio_espacial
    ].map(norm).filter(Boolean);

    const code = norm(site.co_iphan);
    const id = norm(site.id_bem);

    const includes = (value, term) =>
      Boolean(term) &&
      term.split(' ').every(t => value.includes(t));

    // Número isolado: pesquisa por ID SICG.

    if (/^\d+$/.test(q)) {
      return id === q;
    }

    // Pesquisa direcionada por atributo.

    const prefix = q.match(
      /^(municipio|mun|sitio|nome|id|codigo)\s*:\s*(.*)$/
    );

    if (prefix) {
      const [, field, term] = prefix;

      if (!term) return false;

      if (field === 'id') return id === term;

      if (field === 'codigo') {
        return code.includes(term);
      }

      if (['municipio', 'mun'].includes(field)) {
        return places.some(p => includes(p, term));
      }

      return includes(name, term);
    }

    // Pesquisa geral, sem distinção de acentos.

    return includes(
      [name, ...places, code, id].join(' '),
      q
    );
  }

  function calculateFromInput() {
    const value = el.coordInput.value.trim();

    if (!value) {
      showToast(
        'Informe coordenadas, nome do sítio ou código cadastral.'
      );
      return;
    }

    state.imageSeq++;

    const parsed = parseCoordinateInput(value);

    if (parsed) {
      runCalculation(parsed.lat, parsed.lon);
      return;
    }

    if (looksLikeCoordinates(value)) {
      showToast(
        'Coordenadas inválidas. Confira os valores e o formato.'
      );
      return;
    }

    runTextSearch(value);
  }

  function runTextSearch(query) {
    if (!state.sites.length) {
      showToast('A base de sítios está vazia.');
      return;
    }

    state.querySeq++;
    state.imageSeq++;

    resetMapPick();

    state.mode = 'text';
    state.searchText = query;
    state.userLat = null;
    state.userLon = null;
    state.page = 1;

    if (state.userMarker) {
      state.map.removeLayer(state.userMarker);
      state.userMarker = null;
    }

    clearRadius();

    const uf = el.ufFilter.value;

    state.results = state.sites
      .filter(site =>
        (!uf || site.uf === uf) &&
        matchesSite(site, query)
      )
      .sort((a, b) =>
        String(a.identificacao_bem || '').localeCompare(
          String(b.identificacao_bem || ''),
          'pt-BR',
          { sensitivity: 'base', numeric: true }
        )
      )
      .map(site => ({
        site,
        km: null
      }));

    el.coordInput.value = query;
    el.calculateButton.disabled = false;
    el.calculateButton.textContent = 'Pesquisar / calcular';

    renderResults();

    if (!state.results.length) {
      showToast('Nenhum sítio corresponde à pesquisa.');
    }
  }

  // ==========================================
  // CALCULO DE DISTANCIAS
  // ==========================================

  async function runCalculation(lat, lon) {
    if (!validPoint(lat, lon)) {
      showToast('Coordenadas fora dos limites válidos.');
      return;
    }

    if (!state.sites.length) {
      showToast('A base de sítios está vazia.');
      return;
    }

    state.imageSeq++;

    const token = ++state.querySeq;

    resetMapPick();

    state.mode = 'spatial';
    state.userLat = lat;
    state.userLon = lon;
    state.searchText = '';

    el.coordInput.value =
      `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

    el.calculateButton.disabled = true;
    el.calculateButton.textContent = 'Calculando…';

    try {
      const radiusRaw = el.radiusInput.value.trim();

      const radiusKm = radiusRaw === ''
        ? null
        : Number(radiusRaw);

      if (radiusKm !== null &&
          (!Number.isFinite(radiusKm) || radiusKm < 0)) {
        throw new Error('Raio máximo inválido.');
      }

      const uf = el.ufFilter.value;

      const values = await calculateDistances(
        lat, lon, radiusKm, uf
      );

      if (token !== state.querySeq) return;

      state.results = values.map(v => ({
        site: state.sites[v.i],
        km: v.km
      }));

      state.page = 1;

      renderUserPoint();
      renderResults();

      if (radiusKm !== null) {
        renderRadius(radiusKm);
      } else {
        clearRadius();
      }

    } catch (error) {
      console.error(error);

      if (token === state.querySeq) {
        showToast(
          error.message || 'Não foi possível concluir o cálculo.'
        );
      }

    } finally {
      if (token === state.querySeq) {
        el.calculateButton.disabled = false;
        el.calculateButton.textContent = 'Pesquisar / calcular';
      }
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

  // ==========================================
  // TABELA DE RESULTADOS
  // ==========================================

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
      const hasDistance = Number.isFinite(entry.km);
      const meters = hasDistance ? entry.km * 1000 : null;
      const near = hasDistance && meters <= margin;
      const tr = document.createElement('tr');

      const sicgUrl = site.id_bem
        ? `${state.config.sicgDetailBaseUrl}${encodeURIComponent(site.id_bem)}`
        : '';

      const distanceText = hasDistance
        ? formatDistance(meters)
        : '—';

      const proximity = hasDistance
        ? (near ? `≤ ${margin} m` : 'Não')
        : '—';

      tr.innerHTML = `
        <td data-label="#">${start + offset + 1}</td>

        <td data-label="IPHAN">
          ${escapeHtml(site.co_iphan || '—')}
        </td>

        <td data-label="Sítio">
          <strong>${escapeHtml(
            site.identificacao_bem || 'Sem identificação'
          )}</strong>
        </td>

        <td data-label="Município/UF">
          ${escapeHtml(
            [municipio(site), site.uf]
              .filter(Boolean).join(' / ') || '—'
          )}
        </td>

        <td data-label="Distância" class="distance">
          ${distanceText}
        </td>

        <td data-label="Proximidade"
            class="${near ? 'proximity-yes' : 'proximity-no'}">
          ${proximity}
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

            ${state.mode === 'text' && sitePoint(site) ? `
              <button class="button ghost compact"
                      type="button"
                      data-reference-key="${escapeAttr(siteKey(site))}">
                Usar como referência
              </button>
            ` : ''}

          </div>
        </td>
      `;

      el.resultsBody.appendChild(tr);
    });

    el.resultsBody.querySelectorAll(
      '[data-detail-key]'
    ).forEach(button => {
      button.addEventListener('click', () => {
        openDetails(button.dataset.detailKey);
      });
    });

    el.resultsBody.querySelectorAll(
      '[data-reference-key]'
    ).forEach(button => {
      button.addEventListener('click', () => {
        useSiteAsReference(button.dataset.referenceKey);
      });
    });

    el.emptyState.hidden = total > 0;
    el.tableWrap.hidden = total === 0;
    el.pagination.hidden = total === 0;
    el.csvButton.disabled = total === 0;

    if (!total) {
      el.emptyState.innerHTML =
        '<strong>Nenhum sítio encontrado.</strong>' +
        '<span>Revise a pesquisa ou os filtros utilizados.</span>';
    }

    if (state.mode === 'text') {
      el.resultSummary.textContent =
        `${total.toLocaleString('pt-BR')} sítio(s) encontrados · ` +
        `Pesquisa: ${state.searchText} · Sem referência espacial`;

      el.mapHint.textContent =
        'Pesquisa cadastral. Selecione um sítio para utilizá-lo ' +
        'como referência de distância.';

    } else {
      el.resultSummary.textContent =
        `${total.toLocaleString('pt-BR')} sítio(s) encontrados · ` +
        `ponto ${state.userLat.toFixed(6)}, ${state.userLon.toFixed(6)}`;

      el.mapHint.textContent =
        'Os marcadores exibem apenas os resultados da página atual.';
    }

    renderPagination(totalPages);
    renderMapPage(pageItems);
  }

  function useSiteAsReference(key) {
    const site = state.sites.find(s => siteKey(s) === key);
    const point = sitePoint(site);

    if (!point) {
      showToast('Este sítio não possui coordenadas válidas.');
      return;
    }

    if (el.detailDialog.open) {
      el.detailDialog.close();
    }

    state.map.closePopup();

    // A nova consulta mantém os filtros de UF e raio definidos.

    runCalculation(point.lat, point.lon);
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

  // ==========================================
  // MARCADOR DO PONTO DE CONSULTA
  // ==========================================

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

    state.map.setView(
      point, Math.max(state.map.getZoom(), 9)
    );
  }

  // ==========================================
  // MARCADORES E POPUPS
  // ==========================================

  function renderMapPage(pageItems) {
    state.markers.clearLayers();

    const bounds = L.latLngBounds([]);

    if (validPoint(state.userLat, state.userLon)) {
      bounds.extend([state.userLat, state.userLon]);
    }

    for (const entry of pageItems) {
      const site = entry.site;
      const point = sitePoint(site);

      if (!point) continue;

      const { lat, lon } = point;
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

      const distance = Number.isFinite(entry.km)
        ? `<br>${formatDistance(entry.km * 1000)}`
        : '';

      popup.innerHTML = `
        <strong>${escapeHtml(
          site.identificacao_bem || 'Sítio arqueológico'
        )}</strong>
        <br>${escapeHtml(site.co_iphan || '')}
        ${distance}
      `;

      const photoSlot = document.createElement('div');
      const summary = document.createElement('div');

      summary.className = 'pm-popup-sintese';

      popup.append(
        photoSlot,
        summary,
        makeButton('Ficha completa', () => openDetails(key))
      );

      if (state.mode === 'text') {
        popup.append(
          makeButton(
            'Usar como referência',
            () => useSiteAsReference(key)
          )
        );
      }

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
            .replace(/\s+/g, ' ').trim();

          const preview = text.length > 220
            ? text.slice(0, 220).trimEnd() + '…'
            : text;

          summary.innerHTML =
            `<strong>Síntese</strong>${escapeHtml(
              preview || 'Não informada pelo SICG.'
            )}`;

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

    if (bounds.isValid()) {
      state.map.fitBounds(bounds, {
        padding: [28, 28],
        maxZoom: 12
      });
    }
  }

  function renderRadius(km) {
  clearRadius();

  state.radiusCircle = L.circle(
    [state.userLat, state.userLon],
    {
      radius: km * 1000,
      color: '#67a7e8',
      weight: 2,
      fillColor: '#67a7e8',
      fillOpacity: 0.06,

      // Impede a interceptação dos cliques
      interactive: false

    }
  ).addTo(state.map);

  // Mantém o círculo atrás dos marcadores
  state.radiusCircle.bringToBack();
  }
  }

  // ==========================================
  // BASE FOTOGRAFICA DO SICG
  // ==========================================

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
      renderDatasetStatus();

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
        if (!data || typeof data !== 'object' ||
            Array.isArray(data)) {
          throw new Error('Base de detalhes inválida.');
        }

        state.details = data;
        return data;

      }).finally(() => {
        state.detailsPromise = null;
      });
    }

    return state.detailsPromise;
  }

  function exibirFoto(
    container, url, compact = false, onLayout = () => {}
  ) {
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

  // ==========================================
  // FICHA ARQUEOLOGICA RESPONSIVA
  // ==========================================

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
        ['Município', municipio(site, detail)],
        ['UF', site.uf],
        ['Classificação',
          site.ds_classificacao || detail.ds_classificacao],
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
        if (active()) frame.replaceChildren(img);
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

    showPhoto(
      normalizarFoto(detail.imagem_url) ||
      state.photos?.[id]
    );

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

    const photosTask = carregarFotografias().then(photos => {
      showPhoto(photos[id]);
    });

    await Promise.allSettled([detailsTask, photosTask]);

    if (active() && !displayedUrl) {
      if (state.photosUnavailable) {
        frame.textContent = 'Base fotográfica indisponível.';
      } else {
        figure.hidden = true;
        top.classList.add('sem-foto');
      }
    }
  }

  function siteKey(site) {
    if (site?.id_bem !== null &&
        site?.id_bem !== undefined &&
        site.id_bem !== '') {
      return String(site.id_bem);
    }

    if (site?.co_iphan) {
      return `co:${site.co_iphan}`;
    }

    return `coord:${site?.coordinates?.join(',') || ''}:${site?.identificacao_bem || ''}`;
  }

  // ==========================================
  // GEOLOCALIZACAO
  // ==========================================

  function useDeviceLocation() {
    if (!navigator.geolocation) {
      showToast('Este navegador não fornece geolocalização.');
      return;
    }

    el.useLocationButton.disabled = true;

    navigator.geolocation.getCurrentPosition(pos => {
      el.useLocationButton.disabled = false;

      const { latitude, longitude, accuracy } = pos.coords;

      showToast(
        `Localização obtida. Precisão: ±${Math.round(accuracy)} m.`
      );

      runCalculation(latitude, longitude);

    }, err => {
      el.useLocationButton.disabled = false;

      showToast(
        `Não foi possível obter a localização: ${err.message}`
      );

    }, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 30000
    });
  }

  // ==========================================
  // NOVA LEITURA BINARIA EXIF
  // ==========================================

  function fileToBuffer(file) {
    if (typeof file.arrayBuffer === 'function') {
      return file.arrayBuffer();
    }

    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => resolve(reader.result);
      reader.onerror = () => {
        reject(new Error('Não foi possível ler o arquivo.'));
      };

      reader.readAsArrayBuffer(file);
    });
  }

  // Interpreta os diretórios TIFF utilizados pelo EXIF.

  function gpsFromTiff(buffer, offset, length) {
    const v = new DataView(buffer, offset, length);
    const order = v.getUint16(0, false);

    if (![0x4949, 0x4d4d].includes(order)) {
      throw new Error('Cabeçalho EXIF inválido.');
    }

    const le = order === 0x4949;
    const u16 = p => v.getUint16(p, le);
    const u32 = p => v.getUint32(p, le);

    if (u16(2) !== 42) {
      throw new Error('Formato TIFF não suportado.');
    }

    function ifd(p) {
      const n = u16(p);
      const tags = new Map();

      if (p + 2 + n * 12 > v.byteLength) {
        throw new Error('Metadados EXIF incompletos.');
      }

      for (let i = 0; i < n; i++) {
        const j = p + 2 + i * 12;

        tags.set(u16(j), {
          type: u16(j + 2),
          count: u32(j + 4),
          pos: j + 8
        });
      }

      return tags;
    }

    const pointer = ifd(u32(4)).get(0x8825);

    if (!pointer) return null;

    if (pointer.type !== 4 || pointer.count !== 1) {
      throw new Error('Referência GPS inválida.');
    }

    const tags = ifd(u32(pointer.pos));

    const ref = t => {
      if (!t || t.type !== 2 || t.count < 1) {
        throw new Error('Hemisfério GPS não informado.');
      }

      return String.fromCharCode(
        v.getUint8(t.count <= 4 ? t.pos : u32(t.pos))
      ).toUpperCase();
    };

    const dms = t => {
      if (!t || t.type !== 5 || t.count !== 3) {
        throw new Error('Coordenadas GPS incompletas.');
      }

      const p = u32(t.pos);

      const a = [0, 8, 16].map(i => {
        const denominator = u32(p + i + 4);

        if (!denominator) {
          throw new Error('Denominador GPS inválido.');
        }

        return u32(p + i) / denominator;
      });

      if (a[1] >= 60 || a[2] >= 60) {
        throw new Error('Minutos ou segundos GPS inválidos.');
      }

      return a[0] + a[1] / 60 + a[2] / 3600;
    };

    if (![1, 2, 3, 4].some(k => tags.has(k))) {
      return null;
    }

    const ns = ref(tags.get(1));
    const ew = ref(tags.get(3));

    const lat = dms(tags.get(2));
    const lon = dms(tags.get(4));

    if (!['N', 'S'].includes(ns) ||
        !['E', 'W'].includes(ew) ||
        lat > 90 || lon > 180) {
      throw new Error('Coordenadas GPS fora dos limites válidos.');
    }

    return {
      lat: ns === 'S' ? -lat : lat,
      lon: ew === 'W' ? -lon : lon
    };
  }

  // Localiza o bloco EXIF sem decodificar a fotografia.

  function readGpsExif(buffer) {
    const v = new DataView(buffer);
    const n = v.byteLength;

    if (n < 8) {
      throw new Error('Arquivo vazio ou incompleto.');
    }

    const ascii = (p, len) => String.fromCharCode(
      ...new Uint8Array(buffer, p, len)
    );

    const parse = (p, len) => {
      if (len >= 6 && ascii(p, 6) === 'Exif\0\0') {
        p += 6;
        len -= 6;
      }

      return gpsFromTiff(buffer, p, len);
    };

    // JPEG / JPG

    if (v.getUint16(0) === 0xffd8) {
      let p = 2;

      while (p + 1 < n) {
        if (v.getUint8(p++) !== 0xff) break;

        while (p < n && v.getUint8(p) === 0xff) p++;

        if (p >= n) break;

        const marker = v.getUint8(p++);

        if (marker === 0xda || marker === 0xd9) break;

        if (marker === 0x01 ||
            (marker >= 0xd0 && marker <= 0xd7)) {
          continue;
        }

        if (p + 2 > n) break;

        const len = v.getUint16(p);

        if (len < 2 || p + len > n) {
          throw new Error('Segmento JPEG incompleto.');
        }

        if (marker === 0xe1 &&
            len >= 8 &&
            ascii(p + 2, 6) === 'Exif\0\0') {

          const gps = parse(p + 2, len - 2);

          if (gps) return gps;
        }

        p += len;
      }

      return null;
    }

    // TIFF

    if (['II', 'MM'].includes(ascii(0, 2))) {
      return parse(0, n);
    }

    // PNG com bloco eXIf

    if (v.getUint32(0) === 0x89504e47 &&
        v.getUint32(4) === 0x0d0a1a0a) {

      for (let p = 8; p + 12 <= n;) {
        const len = v.getUint32(p);
        const type = ascii(p + 4, 4);

        if (len > n - p - 12) {
          throw new Error('Arquivo PNG incompleto.');
        }

        if (type === 'eXIf') {
          return parse(p + 8, len);
        }

        if (type === 'IEND') break;

        p += len + 12;
      }

      return null;
    }

    // WebP com bloco EXIF

    if (n >= 12 &&
        ascii(0, 4) === 'RIFF' &&
        ascii(8, 4) === 'WEBP') {

      for (let p = 12; p + 8 <= n;) {
        const len = v.getUint32(p + 4, true);
        const type = ascii(p, 4);

        if (len > n - p - 8) {
          throw new Error('Arquivo WebP incompleto.');
        }

        if (type === 'EXIF') {
          return parse(p + 8, len);
        }

        p += 8 + len + (len % 2);
      }

      return null;
    }

    throw new Error(
      'Formato não suportado. Utilize JPEG, TIFF, PNG ou WebP com EXIF.'
    );
  }

  // ==========================================
  // PROCESSAMENTO DA FOTOGRAFIA DO USUARIO
  // ==========================================

  async function handleImageExif(event) {
    const file = event.target.files?.[0];

    if (!file) return;

    const token = ++state.imageSeq;

    el.imageStatus.textContent =
      `Lendo metadados GPS de ${file.name}…`;

    try {
      const buffer = await fileToBuffer(file);

      if (token !== state.imageSeq) return;

      const gps = readGpsExif(buffer);

      if (!gps) {
        el.imageStatus.textContent =
          'O arquivo recebido não contém GPS EXIF. ' +
          'Selecione a fotografia original pelo gerenciador Arquivos. ' +
          'A galeria ou o sistema pode ter removido a localização.';

        showToast('Metadados GPS não encontrados.');
        return;
      }

      const { lat, lon } = gps;

      if (!validPoint(lat, lon)) {
        throw new Error('Coordenadas GPS inválidas.');
      }

      el.coordInput.value =
        `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

      el.imageStatus.textContent =
        `GPS extraído: ${lat.toFixed(6)}, ${lon.toFixed(6)}. ` +
        'A fotografia permanece no dispositivo.';

      console.info('[ProxiMetria] GPS EXIF:', {
        arquivo: file.name,
        tamanho: file.size,
        latitude: lat,
        longitude: lon
      });

      // Envia diretamente os valores numéricos ao cálculo,
      // sem reinterpretar a caixa de entrada.

      runCalculation(lat, lon);

    } catch (error) {
      if (token !== state.imageSeq) return;

      console.warn('Erro na leitura EXIF:', error);

      const message = error instanceof RangeError
        ? 'Estrutura EXIF incompleta ou corrompida.'
        : error.message || 'Erro ao interpretar os metadados.';

      el.imageStatus.textContent =
        `${message} Tente selecionar o arquivo original.`;

      showToast('Não foi possível extrair o GPS da fotografia.');
    }
  }

  // ==========================================
  // EXPORTACAO CSV
  // ==========================================

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
        municipio(s),
        s.uf ?? '',
        s.coordinates?.[0] ?? '',
        s.coordinates?.[1] ?? '',
        Number.isFinite(entry.km)
          ? (entry.km * 1000).toFixed(2)
          : ''
      ].map(csvCell).join(';'));
    });

    const blob = new Blob(
      ['\ufeff' + lines.join('\n')],
      { type: 'text/csv;charset=utf-8;' }
    );

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    a.href = url;
    a.download =
      `proximetria_${new Date().toISOString().slice(0, 10)}.csv`;

    a.click();
    URL.revokeObjectURL(url);
  }

  function csvCell(value) {
    const text = String(value ?? '');

    return /[;"\n]/.test(text)
      ? `"${text.replace(/"/g, '""')}"`
      : text;
  }

  // ==========================================
  // FUNCOES AUXILIARES
  // ==========================================

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ao carregar ${url}`
      );
    }

    return response.json();
  }

  function formatDistance(meters) {
    if (!Number.isFinite(meters)) return '—';

    if (meters < 1000) {
      return `${meters.toFixed(meters < 100 ? 1 : 0)} m`;
    }

    return `${(meters / 1000).toLocaleString('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 3
    })} km`;
  }

  function formatCoordinates(coord) {
    const point = sitePoint({ coordinates: coord });

    return point
      ? `${point.lat.toFixed(7)}, ${point.lon.toFixed(7)}`
      : '—';
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

  // ==========================================
  // SERVICE WORKER
  // ==========================================

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
