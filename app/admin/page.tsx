"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type DriverRow = { id: number; name: string };
type VehicleRow = { id: number; name: string };
type LocationRow = { id: number; name: string; kind?: string | null };
type FareRow = { from_id: number; to_id: number; amount_yen: number };

function getAdminKeyStorage() {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("pickup_admin_key") ?? "";
}

function setAdminKeyStorage(value: string) {
  if (typeof window === "undefined") return;
  if (value) {
    localStorage.setItem("pickup_admin_key", value);
    return;
  }
  localStorage.removeItem("pickup_admin_key");
}

async function readJson(res: Response) {
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new Error(data?.error || text || `HTTP ${res.status}`);
  }
  return data;
}

function normalizeItems<T>(data: any): T[] {
  if (!data) return [];
  if (Array.isArray(data)) return data as T[];
  if (Array.isArray(data.items)) return data.items as T[];
  if (Array.isArray(data.data)) return data.data as T[];
  return [];
}

export default function AdminPage() {
  const [adminKey, setAdminKey] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);

  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [vehicles, setVehicles] = useState<VehicleRow[]>([]);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [fares, setFares] = useState<FareRow[]>([]);

  const [newDriverName, setNewDriverName] = useState("");
  const [newVehicleName, setNewVehicleName] = useState("");
  const [newLocationName, setNewLocationName] = useState("");

  const [fareFromId, setFareFromId] = useState<number | "">("");
  const [fareToId, setFareToId] = useState<number | "">("");
  const [fareAmount, setFareAmount] = useState("");

  const [openDrivers, setOpenDrivers] = useState(false);
  const [openVehicles, setOpenVehicles] = useState(false);
  const [openLocations, setOpenLocations] = useState(false);
  const [openFares, setOpenFares] = useState(false);

  async function apiGet(path: string) {
    const res = await fetch(`${path}?ts=${Date.now()}`, { cache: "no-store" });
    return readJson(res);
  }

  async function apiPost(path: string, body: any) {
    const res = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-key": adminKey,
      },
      body: JSON.stringify(body),
    });
    return readJson(res);
  }

  async function apiDelete(path: string, body: any) {
    const res = await fetch(path, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        "x-admin-key": adminKey,
      },
      body: JSON.stringify(body),
    });
    return readJson(res);
  }

  function resetAdminKey(message = "保存済みの管理キーを消しました。再入力してください。") {
    setAdminKeyStorage("");
    setAdminKey("");
    setAuthenticated(false);
    setStatus(message);
  }

  async function validateAdminKey(candidate: string) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      return { ok: false, message: "ADMIN_KEYを入力してください" };
    }

    const res = await fetch("/api/admin/drivers", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-key": trimmed,
      },
      body: JSON.stringify({}),
    });

    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (res.status === 400) {
      return { ok: true, message: "" };
    }

    if (res.status === 401) {
      return {
        ok: false,
        message: "管理キーが無効です。保存済みキーを消して、正しいキーを再入力してください。",
      };
    }

    return {
      ok: res.ok,
      message: data?.error || text || `HTTP ${res.status}`,
    };
  }

  function handleAdminKeyError(message?: string) {
    resetAdminKey(
      message || "管理キーが無効です。保存済みキーを消して、正しいキーを再入力してください。"
    );
  }

  function describeMutationError(error: any, fallback: string) {
    const message = error?.message ?? fallback;
    if (message === "Unauthorized") {
      handleAdminKeyError();
      return "管理キーが無効です。再入力してください。";
    }
    return message;
  }

  useEffect(() => {
    const saved = getAdminKeyStorage().trim();
    if (!saved) {
      setAuthChecking(false);
      return;
    }

    setAdminKey(saved);
    void (async () => {
      const result = await validateAdminKey(saved);
      if (result.ok) {
        setAuthenticated(true);
      } else {
        handleAdminKeyError(result.message);
      }
      setAuthChecking(false);
    })();
  }, []);

  async function reloadAll() {
    setLoading(true);
    setStatus("");
    try {
      const [driversRes, vehiclesRes, locationsRes, faresRes] = await Promise.all([
        apiGet("/api/admin/drivers"),
        apiGet("/api/admin/vehicles"),
        apiGet("/api/admin/locations"),
        apiGet("/api/admin/fares"),
      ]);

      setDrivers(
        normalizeItems<DriverRow>(driversRes).sort((a, b) => a.name.localeCompare(b.name, "ja"))
      );
      setVehicles(
        normalizeItems<VehicleRow>(vehiclesRes).sort((a, b) => a.name.localeCompare(b.name, "ja"))
      );
      setLocations(
        normalizeItems<LocationRow>(locationsRes).sort((a, b) => a.name.localeCompare(b.name, "ja"))
      );
      setFares(normalizeItems<FareRow>(faresRes));
    } catch (e: any) {
      setStatus(e?.message ?? "読込失敗");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (authenticated) {
      reloadAll();
    }
  }, [authenticated]);

  const locationNameMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const l of locations) m.set(l.id, l.name);
    return m;
  }, [locations]);

  const fareRowsForView = useMemo(() => {
    return [...fares].sort((a, b) => {
      const aFrom = locationNameMap.get(a.from_id) ?? "";
      const bFrom = locationNameMap.get(b.from_id) ?? "";
      if (aFrom !== bFrom) return aFrom.localeCompare(bFrom, "ja");
      const aTo = locationNameMap.get(a.to_id) ?? "";
      const bTo = locationNameMap.get(b.to_id) ?? "";
      return aTo.localeCompare(bTo, "ja");
    });
  }, [fares, locationNameMap]);

  async function saveAdminKey() {
    const trimmed = adminKey.trim();
    if (!trimmed) {
      setStatus("ADMIN_KEYを入力してください");
      return;
    }

    setLoading(true);
    setStatus("");
    try {
      const result = await validateAdminKey(trimmed);
      if (!result.ok) {
        setStatus(result.message || "管理キーを確認できませんでした");
        setAuthenticated(false);
        return;
      }

      setAdminKeyStorage(trimmed);
      setAdminKey(trimmed);
      setAuthenticated(true);
      setStatus("管理キーを保存しました");
    } catch (e: any) {
      setStatus(e?.message ?? "管理キー確認に失敗しました");
      setAuthenticated(false);
    } finally {
      setLoading(false);
      setAuthChecking(false);
    }
  }

  async function addDriver() {
    if (!newDriverName.trim()) return;
    try {
      setStatus("");
      await apiPost("/api/admin/drivers", { name: newDriverName.trim() });
      localStorage.setItem("pickup_masters_updated_at", String(Date.now()));
      setNewDriverName("");
      setStatus("運転手を追加しました");
      await reloadAll();
    } catch (e: any) {
      setStatus(describeMutationError(e, "追加失敗"));
    }
  }

  async function deleteDriver(id: number) {
    try {
      setStatus("");
      await apiDelete("/api/admin/drivers", { id });
      localStorage.setItem("pickup_masters_updated_at", String(Date.now()));
      setStatus("運転手を削除しました");
      await reloadAll();
    } catch (e: any) {
      setStatus(describeMutationError(e, "削除失敗"));
    }
  }

  async function addVehicle() {
    if (!newVehicleName.trim()) return;
    try {
      setStatus("");
      await apiPost("/api/admin/vehicles", { name: newVehicleName.trim() });
      localStorage.setItem("pickup_masters_updated_at", String(Date.now()));
      setNewVehicleName("");
      setStatus("車両を追加しました");
      await reloadAll();
    } catch (e: any) {
      setStatus(describeMutationError(e, "追加失敗"));
    }
  }

  async function deleteVehicle(id: number) {
    try {
      setStatus("");
      await apiDelete("/api/admin/vehicles", { id });
      localStorage.setItem("pickup_masters_updated_at", String(Date.now()));
      setStatus("車両を削除しました");
      await reloadAll();
    } catch (e: any) {
      setStatus(describeMutationError(e, "削除失敗"));
    }
  }

  async function addLocation() {
    if (!newLocationName.trim()) return;
    try {
      setStatus("");
      await apiPost("/api/admin/locations", { name: newLocationName.trim() });
      localStorage.setItem("pickup_masters_updated_at", String(Date.now()));
      setNewLocationName("");
      setStatus("地点を追加しました");
      await reloadAll();
    } catch (e: any) {
      setStatus(describeMutationError(e, "追加失敗"));
    }
  }

  async function deleteLocation(id: number) {
    try {
      setStatus("");
      await apiDelete("/api/admin/locations", { id });
      localStorage.setItem("pickup_masters_updated_at", String(Date.now()));
      setStatus("地点を削除しました");
      await reloadAll();
    } catch (e: any) {
      setStatus(describeMutationError(e, "削除失敗"));
    }
  }

  async function addOrUpdateFare() {
    if (!fareFromId || !fareToId || !fareAmount.trim()) return;
    try {
      setStatus("");
      await apiPost("/api/admin/fares", {
        from_id: Number(fareFromId),
        to_id: Number(fareToId),
        amount_yen: Number(fareAmount),
      });
      localStorage.setItem("pickup_masters_updated_at", String(Date.now()));
      setFareFromId("");
      setFareToId("");
      setFareAmount("");
      setStatus("区間運賃を追加 / 更新しました");
      await reloadAll();
    } catch (e: any) {
      setStatus(describeMutationError(e, "追加 / 更新失敗"));
    }
  }

  async function deleteFare(from_id: number, to_id: number) {
    try {
      setStatus("");
      await apiDelete("/api/admin/fares", { from_id, to_id });
      localStorage.setItem("pickup_masters_updated_at", String(Date.now()));
      setStatus("区間運賃を削除しました");
      await reloadAll();
    } catch (e: any) {
      setStatus(describeMutationError(e, "削除失敗"));
    }
  }

  if (authChecking) {
    return (
      <main className="min-h-screen w-full bg-[linear-gradient(180deg,#020617_0%,#030712_100%)] px-4 py-8 text-white">
        <div className="mx-auto max-w-xl rounded-[28px] border border-white/10 bg-[rgba(2,6,23,0.80)] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.35)]">
          <h1 className="text-3xl font-extrabold tracking-[-0.04em]">管理ページ</h1>
          <p className="mt-4 text-white/70">保存済みの管理キーを確認しています...</p>
        </div>
      </main>
    );
  }

  if (!authenticated) {
    return (
      <main className="min-h-screen w-full bg-[linear-gradient(180deg,#020617_0%,#030712_100%)] px-4 py-8 text-white">
        <div className="mx-auto max-w-xl rounded-[28px] border border-white/10 bg-[rgba(2,6,23,0.80)] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.35)]">
          <h1 className="text-3xl font-extrabold tracking-[-0.04em]">管理ページ</h1>
          <p className="mt-2 text-white/55">ADMIN_KEY を入力してください</p>

          <input
            type="password"
            value={adminKey}
            onChange={(e) => setAdminKey(e.target.value)}
            placeholder="ADMIN_KEY"
            className="mt-6 min-h-[58px] w-full rounded-[20px] border border-white/10 bg-black/20 px-4 text-xl text-white outline-none"
          />

          <button
            type="button"
            onClick={saveAdminKey}
            disabled={loading}
            className="mt-4 min-h-[58px] w-full rounded-[20px] border border-blue-400/30 bg-[#20357b] text-xl font-bold"
          >
            {loading ? "確認中..." : "入る"}
          </button>

          <button
            type="button"
            onClick={() => resetAdminKey()}
            className="mt-3 min-h-[52px] w-full rounded-[18px] border border-white/10 bg-white/5 text-base font-bold text-white/85"
          >
            管理キーを消す / 再入力
          </button>

          <div className="mt-4 flex flex-col gap-3">
            <Link href="http://localhost:3000/admin-portal" className="text-white/70 underline flex items-center gap-1">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                <polyline points="9 22 9 12 15 12 15 22"></polyline>
              </svg>
              システム管理ページへ戻る
            </Link>
            <Link href="/" className="text-white/70 underline">
              入力ページへ戻る
            </Link>
          </div>

          {status ? <div className="mt-4 text-white/75">{status}</div> : null}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen w-full bg-[linear-gradient(180deg,#020617_0%,#030712_100%)] px-4 py-6 text-white sm:px-6 sm:py-8">
      <div className="mx-auto max-w-4xl rounded-[28px] border border-white/10 bg-[rgba(2,6,23,0.80)] p-4 shadow-[0_20px_60px_rgba(0,0,0,0.35)] sm:p-6">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-extrabold tracking-[-0.04em]">管理ページ</h1>
            <p className="mt-2 text-white/55">運転手・車両・地点・区間運賃を管理します</p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => resetAdminKey()}
              className="inline-flex min-h-[52px] items-center justify-center rounded-[18px] border border-amber-400/30 bg-amber-500/10 px-5 text-base font-bold text-amber-100 transition hover:bg-amber-500/20"
            >
              管理キーを消す / 再入力
            </button>
            <Link
              href="http://localhost:3000/admin-portal"
              className="inline-flex min-h-[52px] items-center justify-center gap-2 rounded-[18px] border border-white/10 bg-[rgba(15,23,42,0.8)] px-5 text-base font-bold text-white transition hover:-translate-y-[2px] hover:bg-[rgba(30,41,59,0.9)] backdrop-blur-md"
              style={{
                boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1), 0 2px 4px rgba(0, 0, 0, 0.06)"
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                <polyline points="9 22 9 12 15 12 15 22"></polyline>
              </svg>
              システム管理ページへ戻る
            </Link>
            <Link
              href="/"
              className="inline-flex min-h-[52px] items-center justify-center rounded-[18px] border border-white/10 bg-white/5 px-5 text-base font-bold transition hover:bg-white/10"
            >
              入力ページへ戻る
            </Link>
          </div>
        </div>

        <div className="space-y-6">
          <section className="rounded-[24px] border border-white/10 bg-white/[0.03] p-4">
            <h2 className="mb-4 text-2xl font-extrabold">運転手を追加</h2>
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                value={newDriverName}
                onChange={(e) => setNewDriverName(e.target.value)}
                placeholder="運転手名"
                className="min-h-[56px] flex-1 rounded-[18px] border border-white/10 bg-black/20 px-4 text-xl text-white outline-none"
              />
              <button
                type="button"
                onClick={addDriver}
                className="min-h-[56px] rounded-[18px] border border-blue-400/30 bg-[#3158d8] px-5 text-lg font-bold"
              >
                追加
              </button>
            </div>
          </section>

          <section className="rounded-[24px] border border-white/10 bg-white/[0.03] p-4">
            <h2 className="mb-4 text-2xl font-extrabold">車両を追加</h2>
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                value={newVehicleName}
                onChange={(e) => setNewVehicleName(e.target.value)}
                placeholder="車両名"
                className="min-h-[56px] flex-1 rounded-[18px] border border-white/10 bg-black/20 px-4 text-xl text-white outline-none"
              />
              <button
                type="button"
                onClick={addVehicle}
                className="min-h-[56px] rounded-[18px] border border-blue-400/30 bg-[#3158d8] px-5 text-lg font-bold"
              >
                追加
              </button>
            </div>
          </section>

          <section className="rounded-[24px] border border-white/10 bg-white/[0.03] p-4">
            <h2 className="mb-4 text-2xl font-extrabold">地点を追加</h2>
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                value={newLocationName}
                onChange={(e) => setNewLocationName(e.target.value)}
                placeholder="地点名"
                className="min-h-[56px] flex-1 rounded-[18px] border border-white/10 bg-black/20 px-4 text-xl text-white outline-none"
              />
              <button
                type="button"
                onClick={addLocation}
                className="min-h-[56px] rounded-[18px] border border-blue-400/30 bg-[#3158d8] px-5 text-lg font-bold"
              >
                追加
              </button>
            </div>
          </section>

          <section className="rounded-[24px] border border-white/10 bg-white/[0.03] p-4">
            <h2 className="mb-4 text-2xl font-extrabold">区間運賃を追加 / 更新</h2>
            <div className="space-y-3">
              <select
                value={fareFromId}
                onChange={(e) => setFareFromId(e.target.value ? Number(e.target.value) : "")}
                className="min-h-[56px] w-full rounded-[18px] border border-white/10 bg-black/20 px-4 text-xl text-white outline-none"
              >
                <option value="">出発地を選択</option>
                {locations.map((l) => (
                  <option key={`fare-from-${l.id}`} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>

              <select
                value={fareToId}
                onChange={(e) => setFareToId(e.target.value ? Number(e.target.value) : "")}
                className="min-h-[56px] w-full rounded-[18px] border border-white/10 bg-black/20 px-4 text-xl text-white outline-none"
              >
                <option value="">到着地を選択</option>
                {locations.map((l) => (
                  <option key={`fare-to-${l.id}`} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>

              <input
                value={fareAmount}
                onChange={(e) => setFareAmount(onlyDigits(e.target.value))}
                placeholder="金額（円）"
                className="min-h-[56px] w-full rounded-[18px] border border-white/10 bg-black/20 px-4 text-xl text-white outline-none"
              />

              <button
                type="button"
                onClick={addOrUpdateFare}
                className="min-h-[56px] rounded-[18px] border border-blue-400/30 bg-[#3158d8] px-5 text-lg font-bold"
              >
                追加 / 更新
              </button>
            </div>
          </section>

          <ToggleCard
            title="運転手一覧"
            open={openDrivers}
            onToggle={() => setOpenDrivers((v) => !v)}
          >
            <div className="space-y-3">
              {drivers.map((d) => (
                <RowCard
                  key={`driver-${d.id}`}
                  label={d.name}
                  onDelete={() => deleteDriver(d.id)}
                />
              ))}
            </div>
          </ToggleCard>

          <ToggleCard
            title="車両一覧"
            open={openVehicles}
            onToggle={() => setOpenVehicles((v) => !v)}
          >
            <div className="space-y-3">
              {vehicles.map((v) => (
                <RowCard
                  key={`vehicle-${v.id}`}
                  label={v.name}
                  onDelete={() => deleteVehicle(v.id)}
                />
              ))}
            </div>
          </ToggleCard>

          <ToggleCard
            title="地点一覧"
            open={openLocations}
            onToggle={() => setOpenLocations((v) => !v)}
          >
            <div className="space-y-3">
              {locations.map((l) => (
                <RowCard
                  key={`location-${l.id}`}
                  label={l.name}
                  onDelete={() => deleteLocation(l.id)}
                />
              ))}
            </div>
          </ToggleCard>

          <ToggleCard
            title="区間運賃一覧"
            open={openFares}
            onToggle={() => setOpenFares((v) => !v)}
          >
            <div className="space-y-3">
              {fareRowsForView.map((f, idx) => (
                <RowCard
                  key={`fare-${f.from_id}-${f.to_id}-${idx}`}
                  label={`${locationNameMap.get(f.from_id) ?? f.from_id} → ${locationNameMap.get(f.to_id) ?? f.to_id} / ${f.amount_yen}円`}
                  onDelete={() => deleteFare(f.from_id, f.to_id)}
                />
              ))}
            </div>
          </ToggleCard>
        </div>

        {loading ? <div className="mt-6 text-white/65">読込中...</div> : null}
        {status ? <div className="mt-6 whitespace-pre-wrap text-white/80">{status}</div> : null}
      </div>
    </main>
  );
}

function ToggleCard({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[24px] border border-white/10 bg-white/[0.03] p-4">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-2xl font-extrabold">{title}</span>
        <span className="text-lg text-white/70">{open ? "閉じる" : "開く"}</span>
      </button>
      {open ? <div className="mt-4">{children}</div> : null}
    </section>
  );
}

function RowCard({
  label,
  onDelete,
}: {
  label: string;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-[18px] border border-white/10 bg-black/20 px-4 py-3">
      <div className="text-lg text-white">{label}</div>
      <button
        type="button"
        onClick={onDelete}
        className="min-h-[42px] rounded-[14px] border border-red-400/30 bg-red-500/15 px-4 text-sm font-bold text-red-300"
      >
        削除
      </button>
    </div>
  );
}

function onlyDigits(s: string) {
  return (s ?? "").replace(/[^\d]/g, "");
}
