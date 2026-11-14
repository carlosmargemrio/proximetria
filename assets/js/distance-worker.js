let points = [];

function deg2rad(v) { return v * Math.PI / 180; }
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088;
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type === 'init') {
    points = Array.isArray(msg.points) ? msg.points : [];
    self.postMessage({ type: 'ready', count: points.length });
    return;
  }

  if (msg.type === 'calculate') {
    const { lat, lon, radiusKm = null, uf = '' } = msg;
    const out = [];
    for (const p of points) {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
      if (uf && p.uf !== uf) continue;
      const km = haversineKm(lat, lon, p.lat, p.lon);
      if (radiusKm !== null && Number.isFinite(radiusKm) && km > radiusKm) continue;
      out.push({ i: p.i, km });
    }
    out.sort((a, b) => a.km - b.km);
    self.postMessage({ type: 'result', requestId: msg.requestId, values: out });
  }
};
