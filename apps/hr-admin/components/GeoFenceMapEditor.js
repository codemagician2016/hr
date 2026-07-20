'use client';

/**
 * GeoFenceMapEditor — plain-Leaflet polygon editor for Feature 39 geofences.
 *
 * Client-only: Leaflet touches `window`, so it is import()-ed inside useEffect
 * (never at module top). Built with bare Leaflet primitives — NO leaflet-draw:
 *   • click on the map appends a vertex (a draggable DivIcon marker),
 *   • a Polygon layer live-updates from the vertex list,
 *   • "Undo last point" / "Clear" / "Use my location" controls.
 *
 * Coordinate order: Leaflet speaks [lat,lng]; the capture API stores GeoJSON
 * [lng,lat]. This component keeps Leaflet order internally and converts at the
 * boundary — `initialRing` (in) and `onChange` (out) are BOTH GeoJSON [lng,lat].
 *
 * Also exports <ZonesMap zones={...}/> — the read-only renderer used by the
 * "Effective zones" inspector (POLYGON rings + RADIUS circles, auto-fitted).
 */

import { useEffect, useRef, useState } from 'react';
import { ActionButton } from '@/lib/ui';

const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '&copy; OpenStreetMap contributors';
// New-fence default view: India (the product is India-first).
const INDIA_CENTER = [22.5, 78.9];
const INDIA_ZOOM = 5;

// Resolve the tenant theme color for map strokes. Leaflet writes SVG
// presentation attributes, where `var(--theme-primary)` does not resolve —
// so read the CSS var once at draw time instead of hardcoding a brand color.
function themeColor() {
  if (typeof window === 'undefined') return '#4f46e5';
  const v = getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim();
  return v || '#4f46e5';
}

// GeoJSON [lng,lat] ring → Leaflet [lat,lng] pairs.
function ringToLatLngs(ring) {
  if (!Array.isArray(ring)) return [];
  return ring
    .filter((p) => Array.isArray(p) && p.length >= 2)
    .map(([lng, lat]) => [Number(lat), Number(lng)]);
}

export default function GeoFenceMapEditor({ initialRing, onChange, height = 380 }) {
  const containerRef = useRef(null);
  // All Leaflet handles live in a ref — Leaflet objects are mutable and must
  // never drive React re-renders themselves.
  const stateRef = useRef({ L: null, map: null, markers: [], shape: null, verts: [] });
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [count, setCount] = useState(0);
  const [geoError, setGeoError] = useState('');

  function vertexIcon(L) {
    return L.divIcon({
      className: '',
      html: `<span style="display:block;width:12px;height:12px;border-radius:9999px;background:${themeColor()};border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.25)"></span>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    });
  }

  // Push the current ring to the parent in GeoJSON [lng,lat] order.
  function notify() {
    const s = stateRef.current;
    setCount(s.verts.length);
    onChangeRef.current?.(s.verts.map(([lat, lng]) => [lng, lat]));
  }

  // Redraw the polygon layer from the vertex list (polyline while < 3 points).
  function redraw() {
    const s = stateRef.current;
    if (!s.L || !s.map) return;
    if (s.shape) { s.shape.remove(); s.shape = null; }
    if (s.verts.length >= 3) {
      s.shape = s.L.polygon(s.verts, { color: themeColor(), weight: 2, fillOpacity: 0.12 }).addTo(s.map);
    } else if (s.verts.length === 2) {
      s.shape = s.L.polyline(s.verts, { color: themeColor(), weight: 2, dashArray: '4 4' }).addTo(s.map);
    }
  }

  function addVertex(latlng, { silent } = {}) {
    const s = stateRef.current;
    if (!s.L || !s.map) return;
    s.verts.push([latlng[0], latlng[1]]);
    const marker = s.L.marker(latlng, { draggable: true, icon: vertexIcon(s.L) }).addTo(s.map);
    marker._vertIdx = s.verts.length - 1;
    marker.on('drag', () => {
      const p = marker.getLatLng();
      s.verts[marker._vertIdx] = [p.lat, p.lng];
      redraw();
    });
    marker.on('dragend', notify);
    s.markers.push(marker);
    if (!silent) { redraw(); notify(); }
  }

  function undoLast() {
    const s = stateRef.current;
    if (!s.verts.length) return;
    s.verts.pop();
    const m = s.markers.pop();
    if (m) m.remove();
    redraw();
    notify();
  }

  function clearAll() {
    const s = stateRef.current;
    if (!s.verts.length) return;
    s.verts = [];
    s.markers.forEach((m) => m.remove());
    s.markers = [];
    redraw();
    notify();
  }

  function useMyLocation() {
    setGeoError('');
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGeoError('Geolocation is not available in this browser.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => { stateRef.current.map?.setView([pos.coords.latitude, pos.coords.longitude], 17); },
      (err) => setGeoError(err && err.message ? err.message : 'Could not read your location.'),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mod = await import('leaflet'); // client-side only — Leaflet touches window
      const L = mod.default || mod;
      if (cancelled || !containerRef.current) return;
      const map = L.map(containerRef.current, { zoomControl: true });
      L.tileLayer(OSM_URL, { attribution: OSM_ATTRIBUTION, maxZoom: 19 }).addTo(map);
      const s = stateRef.current;
      s.L = L;
      s.map = map;

      const seed = ringToLatLngs(initialRing);
      const seedBounds = seed.length >= 3 ? L.latLngBounds(seed).pad(0.25) : null;
      if (seedBounds) map.fitBounds(seedBounds);
      else map.setView(INDIA_CENTER, INDIA_ZOOM);
      seed.forEach((ll) => addVertex(ll, { silent: true }));
      redraw();
      notify();

      map.on('click', (e) => addVertex([e.latlng.lat, e.latlng.lng]));

      // Leaflet-in-modal gotcha: the container is measured before the modal
      // finishes painting — recompute the size (and re-fit) a beat later.
      setTimeout(() => {
        if (cancelled || !s.map) return;
        s.map.invalidateSize();
        if (seedBounds) s.map.fitBounds(seedBounds);
      }, 50);
    })();
    return () => {
      cancelled = true;
      const s = stateRef.current;
      if (s.map) s.map.remove();
      s.map = null;
      s.L = null;
      s.markers = [];
      s.shape = null;
      s.verts = [];
    };
    // Init once per mount — the modal remounts the editor per fence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <ActionButton onClick={undoLast} disabled={count === 0}>Undo last point</ActionButton>
        <ActionButton onClick={clearAll} disabled={count === 0}>Clear</ActionButton>
        <ActionButton onClick={useMyLocation}>Use my location</ActionButton>
        <span className="ml-auto text-xs text-gray-500">
          {count} point{count === 1 ? '' : 's'}{count < 3 ? ' — click the map to add at least 3' : ''}
        </span>
      </div>
      <div
        ref={containerRef}
        style={{ height }}
        className="w-full rounded-xl border border-gray-200 overflow-hidden"
        aria-label="Geofence map editor"
      />
      {geoError ? <p className="text-xs text-red-600">{geoError}</p> : null}
      <p className="text-xs text-gray-400">Click the map to add a corner; drag a dot to adjust it.</p>
    </div>
  );
}

/* ── ZonesMap — read-only zone renderer (effective-zones inspector) ─────────── */
// zones: [{ kind:'POLYGON', name, ring:[[lng,lat],...] } | { kind:'RADIUS', name, lat, lng, radiusM }]
export function ZonesMap({ zones, height = 260 }) {
  const containerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let map = null;
    (async () => {
      const mod = await import('leaflet');
      const L = mod.default || mod;
      if (cancelled || !containerRef.current) return;
      map = L.map(containerRef.current, { zoomControl: true });
      L.tileLayer(OSM_URL, { attribution: OSM_ATTRIBUTION, maxZoom: 19 }).addTo(map);
      const color = themeColor();
      const boundPoints = [];
      for (const z of Array.isArray(zones) ? zones : []) {
        if (z.kind === 'POLYGON' && Array.isArray(z.ring) && z.ring.length >= 3) {
          const latlngs = ringToLatLngs(z.ring);
          L.polygon(latlngs, { color, weight: 2, fillOpacity: 0.12 }).addTo(map).bindTooltip(z.name || 'Zone');
          latlngs.forEach((ll) => boundPoints.push(ll));
        } else if (z.kind === 'RADIUS' && z.lat != null && z.lng != null) {
          const lat = Number(z.lat);
          const lng = Number(z.lng);
          const radiusM = Number(z.radiusM) || 0;
          L.circle([lat, lng], { radius: radiusM, color, weight: 2, fillOpacity: 0.12 })
            .addTo(map)
            .bindTooltip(z.name || 'Office radius');
          // Approximate the circle's extent in degrees (avoids needing a
          // projected map size before the first view is set).
          const dLat = radiusM / 111320;
          const dLng = dLat / Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
          boundPoints.push([lat - dLat, lng - dLng], [lat + dLat, lng + dLng]);
        }
      }
      const bounds = boundPoints.length ? L.latLngBounds(boundPoints).pad(0.3) : null;
      if (bounds) map.fitBounds(bounds);
      else map.setView(INDIA_CENTER, INDIA_ZOOM);
      setTimeout(() => {
        if (cancelled || !map) return;
        map.invalidateSize();
        if (bounds) map.fitBounds(bounds);
      }, 50);
    })();
    return () => {
      cancelled = true;
      if (map) map.remove();
      map = null;
    };
  }, [zones]);

  return (
    <div
      ref={containerRef}
      style={{ height }}
      className="w-full rounded-xl border border-gray-200 overflow-hidden"
      aria-label="Effective zones map"
    />
  );
}
