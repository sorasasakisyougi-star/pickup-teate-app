"use client";

import { useEffect, useMemo, useState } from "react";

type DriverRow = { id: number; name: string; sort_order: number };
type LocationRow = { id: number; name: string; kind?: string | null };
type FareRow = { from_id: number; to_id: number; amount_yen: number };

async function call(path: string, method: string, adminKey: string, body?: any) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-admin-key": adminKey },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
  return j;
}

export default function Admin() {
  const [adminKey, setAdminKey] = useState("");
  const [status, setStatus] = useState("");

  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [fares, setFares] = useState<FareRow[]>([]);

  const [newDriver, setNewDriver] = useState("");
  const [newLoc, setNewLoc] = useState("");
  const [newKind, setNewKind] = useState("");

  const [fromId, setFromId] = useState<number | "">("");
  const [toId, setToId] = useState<number | "">("");
  const [yen, setYen] = useState<number | "">("");

  useEffect(() => {
    setAdminKey(sessionStorage.getItem("ADMIN_KEY_CACHE") || "");
  }, []);
  useEffect(() => {
    sessionStorage.setItem("ADMIN_KEY_CACHE", adminKey);
  }, [adminKey]);

  const locMap = useMemo(() => new Map(locations.map((l) => [l.id, l.name])), [locations]);

  async function reload() {
    setStatus("");
    const d = await fetch("/api/admin/drivers").then((r) => r.json());
    const l = await fetch("/api/admin/locations").then((r) => r.json());
    const f = await fetch("/api/admin/fares").then((r) => r.json());
    if (!d?.ok) throw new Error(d?.error || "drivers load failed");
    if (!l?.ok) throw new Error(l?.error || "locations load failed");
    if (!f?.ok) throw new Error(f?.error || "fares load failed");
    setDrivers(d.data || []);
    setLocations(l.data || []);
    setFares(f.data || []);
    setStatus("読み込みOK");
  }

  useEffect(() => {
    reload().catch((e) => setStatus(String(e?.message || e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="min-h-screen bg-black text-white px-4 py-10 flex justify-center">
      <div className="w-full max-w-5xl space-y-4">
        <h1 className="text-2xl font-semibold">管理ページ</h1>

        <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="text-sm text-white/70 mb-2">ADMIN_KEY</div>
          <div className="flex gap-2">
            <input
              value={adminKey}
              onChange={(e) => setAdminKey(e.target.value)}
              className="flex-1 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
              placeholder="VercelのADMIN_KEY"
            />
            <button
              onClick={() => reload().catch((e) => setStatus(String(e?.message || e)))}
              className="rounded-xl px-4 py-2 text-sm bg-white/10 hover:bg-white/15"
            >
              再読み込み
            </button>
          </div>
          {status ? <div className="mt-2 text-sm text-white/70">{status}</div> : null}
        </div>

        {/* Drivers */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="text-lg font-semibold mb-3">運転手</div>
          <div className="flex gap-2 mb-3">
            <input
              value={newDriver}
              onChange={(e) => setNewDriver(e.target.value)}
              className="flex-1 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
              placeholder="運転手名"
            />
            <button
              onClick={async () => {
                try {
                  await call("/api/admin/drivers", "POST", adminKey, {
                    name: newDriver,
                    sort_order: drivers.length,
                  });
                  setNewDriver("");
                  await reload();
                } catch (e: any) {
                  setStatus(e?.message || "追加失敗");
                }
              }}
              className="rounded-xl px-4 py-2 text-sm bg-white/10 hover:bg-white/15"
            >
              追加
            </button>
          </div>

          <div className="space-y-2">
            {drivers.map((d) => (
              <div key={d.id} className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/30 p-3">
                <div className="flex-1">{d.name}</div>
                <button
                  onClick={async () => {
                    if (!confirm(`削除する？ ${d.name}`)) return;
                    try {
                      await call("/api/admin/drivers", "DELETE", adminKey, { id: d.id });
                      await reload();
                    } catch (e: any) {
                      setStatus(e?.message || "削除失敗");
                    }
                  }}
                  className="rounded-lg px-3 py-1 text-xs bg-white/10 hover:bg-white/15"
                >
                  削除
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Locations */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="text-lg font-semibold mb-3">地点</div>
          <div className="flex gap-2 mb-3">
            <input
              value={newLoc}
              onChange={(e) => setNewLoc(e.target.value)}
              className="flex-1 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
              placeholder="地点名"
            />
            <input
              value={newKind}
              onChange={(e) => setNewKind(e.target.value)}
              className="w-40 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
              placeholder="kind（任意）"
            />
            <button
              onClick={async () => {
                try {
                  await call("/api/admin/locations", "POST", adminKey, { name: newLoc, kind: newKind || null });
                  setNewLoc("");
                  setNewKind("");
                  await reload();
                } catch (e: any) {
                  setStatus(e?.message || "追加失敗");
                }
              }}
              className="rounded-xl px-4 py-2 text-sm bg-white/10 hover:bg-white/15"
            >
              追加
            </button>
          </div>

          <div className="space-y-2">
            {locations.map((l) => (
              <div key={l.id} className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/30 p-3">
                <div className="flex-1">
                  <div>{l.name}</div>
                  <div className="text-xs text-white/50">kind: {l.kind ?? "-"}</div>
                </div>
                <button
                  onClick={async () => {
                    if (!confirm(`削除する？ ${l.name}`)) return;
                    try {
                      await call("/api/admin/locations", "DELETE", adminKey, { id: l.id });
                      await reload();
                    } catch (e: any) {
                      setStatus(e?.message || "削除失敗");
                    }
                  }}
                  className="rounded-lg px-3 py-1 text-xs bg-white/10 hover:bg-white/15"
                >
                  削除
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Fares */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="text-lg font-semibold mb-3">金額（区間運賃）</div>

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 mb-3">
            <select
              value={fromId}
              onChange={(e) => setFromId(e.target.value ? Number(e.target.value) : "")}
              className="rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
            >
              <option value="">from</option>
              {locations.map((l) => (
                <option key={`f-${l.id}`} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>

            <select
              value={toId}
              onChange={(e) => setToId(e.target.value ? Number(e.target.value) : "")}
              className="rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
            >
              <option value="">to</option>
              {locations.map((l) => (
                <option key={`t-${l.id}`} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>

            <input
              value={yen}
              onChange={(e) => setYen(e.target.value ? Number(e.target.value) : "")}
              className="rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
              placeholder="円"
            />

            <button
              onClick={async () => {
                try {
                  if (fromId === "" || toId === "" || yen === "") return;
                  await call("/api/admin/fares", "POST", adminKey, { from_id: fromId, to_id: toId, amount_yen: yen });
                  setFromId("");
                  setToId("");
                  setYen("");
                  await reload();
                } catch (e: any) {
                  setStatus(e?.message || "保存失敗");
                }
              }}
              className="rounded-xl px-4 py-2 text-sm bg-white/10 hover:bg-white/15"
            >
              追加/更新
            </button>
          </div>

          <div className="space-y-2">
            {fares.map((f) => (
              <div key={`${f.from_id}-${f.to_id}`} className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/30 p-3">
                <div className="flex-1">
                  {locMap.get(f.from_id) ?? f.from_id} → {locMap.get(f.to_id) ?? f.to_id}
                  <div className="text-xs text-white/60">{f.amount_yen.toLocaleString()}円</div>
                </div>
                <button
                  onClick={async () => {
                    if (!confirm("削除する？")) return;
                    try {
                      await call("/api/admin/fares", "DELETE", adminKey, { from_id: f.from_id, to_id: f.to_id });
                      await reload();
                    } catch (e: any) {
                      setStatus(e?.message || "削除失敗");
                    }
                  }}
                  className="rounded-lg px-3 py-1 text-xs bg-white/10 hover:bg-white/15"
                >
                  削除
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="text-xs text-white/40">
          注意：書き込みは ADMIN_KEY が一致した時だけ動く（安全）
        </div>
      </div>
    </main>
  );
}
