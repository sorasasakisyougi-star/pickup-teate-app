import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type DriverRow = {
  id: number;
  name: string;
};

type VehicleRow = {
  id: number;
  name: string;
};

type LocationRow = {
  id: number;
  name: string;
  kind?: string | null;
};

type FareRow = {
  id: number;
  from_id: number;
  to_id: number;
  amount_yen: number;
};

type RouteDistanceRow = {
  id: number;
  from_location_id: number;
  to_location_id: number;
  distance_km: number;
  from_location?: {
    id: number;
    name: string;
  } | null;
  to_location?: {
    id: number;
    name: string;
  } | null;
};

async function readJsonOrThrow(res: Response) {
  const text = await res.text();

  if (!res.ok) {
    throw new Error(text || `HTTP ${res.status}`);
  }

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeItems<T>(json: any): T[] {
  if (!json) return [];
  if (Array.isArray(json)) return json as T[];
  if (Array.isArray(json.items)) return json.items as T[];
  if (Array.isArray(json.data)) return json.data as T[];
  return [];
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

const styles = {
  page: {
    minHeight: "100vh",
    background:
      "radial-gradient(circle at top, rgba(24,80,180,0.18), transparent 28%), linear-gradient(180deg, #020817 0%, #030712 100%)",
    color: "#fff",
    padding: "32px 16px 72px",
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  } as React.CSSProperties,

  container: {
    maxWidth: 980,
    margin: "0 auto",
  } as React.CSSProperties,

  topbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    marginBottom: 28,
    flexWrap: "wrap",
  } as React.CSSProperties,

  title: {
    fontSize: 54,
    fontWeight: 800,
    letterSpacing: "-0.03em",
    margin: 0,
    lineHeight: 1.05,
  } as React.CSSProperties,

  card: {
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(2, 6, 23, 0.78)",
    borderRadius: 24,
    padding: 18,
    boxShadow: "0 16px 50px rgba(0,0,0,0.30)",
    backdropFilter: "blur(12px)",
  } as React.CSSProperties,

  sectionTitle: {
    fontSize: 18,
    fontWeight: 800,
    margin: "0 0 14px",
  } as React.CSSProperties,

  input: {
    width: "100%",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(0,0,0,0.18)",
    color: "#fff",
    padding: "14px 14px",
    outline: "none",
    fontSize: 15,
    boxSizing: "border-box",
  } as React.CSSProperties,

  select: {
    width: "100%",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(0,0,0,0.18)",
    color: "#fff",
    padding: "14px 14px",
    outline: "none",
    fontSize: 15,
    boxSizing: "border-box",
  } as React.CSSProperties,

  primaryBtn: {
    border: "1px solid rgba(99,102,241,0.55)",
    background: "#1d4ed8",
    color: "#fff",
    borderRadius: 14,
    padding: "12px 18px",
    fontWeight: 800,
    fontSize: 14,
    cursor: "pointer",
  } as React.CSSProperties,

  secondaryBtn: {
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(255,255,255,0.04)",
    color: "#fff",
    borderRadius: 14,
    padding: "12px 18px",
    fontWeight: 700,
    fontSize: 14,
    cursor: "pointer",
  } as React.CSSProperties,

  dangerBtn: {
    border: "1px solid rgba(220,38,38,0.5)",
    background: "#b91c1c",
    color: "#fff",
    borderRadius: 12,
    padding: "10px 14px",
    fontWeight: 800,
    fontSize: 13,
    cursor: "pointer",
  } as React.CSSProperties,

  ghostLink: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 46,
    padding: "0 18px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(255,255,255,0.05)",
    color: "#fff",
    textDecoration: "none",
    fontWeight: 800,
    whiteSpace: "nowrap",
  } as React.CSSProperties,

  hr: {
    border: "none",
    borderTop: "1px solid rgba(255,255,255,0.08)",
    margin: "18px 0",
  } as React.CSSProperties,

  row: {
    display: "grid",
    gap: 12,
  } as React.CSSProperties,

  itemCard: {
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.03)",
    borderRadius: 16,
    padding: 14,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
  } as React.CSSProperties,

  itemMeta: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  } as React.CSSProperties,

  itemTitle: {
    fontSize: 16,
    fontWeight: 800,
    lineHeight: 1.3,
  } as React.CSSProperties,

  itemSub: {
    fontSize: 13,
    opacity: 0.72,
    lineHeight: 1.4,
  } as React.CSSProperties,

  collapsibleBtn: {
    width: "100%",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(255,255,255,0.04)",
    color: "#fff",
    padding: "14px 16px",
    textAlign: "left" as const,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  } as React.CSSProperties,

  helper: {
    fontSize: 12,
    opacity: 0.7,
    marginTop: 8,
    lineHeight: 1.5,
  } as React.CSSProperties,

  status: {
    fontSize: 13,
    marginTop: 8,
    opacity: 0.82,
  } as React.CSSProperties,
};

export default function AdminPage() {
  const [adminKey, setAdminKey] = useState("");
  const [statusText, setStatusText] = useState("");

  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [vehicles, setVehicles] = useState<VehicleRow[]>([]);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [fares, setFares] = useState<FareRow[]>([]);
  const [routeDistances, setRouteDistances] = useState<RouteDistanceRow[]>([]);

  const [driverName, setDriverName] = useState("");
  const [vehicleName, setVehicleName] = useState("");
  const [locationName, setLocationName] = useState("");

  const [fareFromId, setFareFromId] = useState("");
  const [fareToId, setFareToId] = useState("");
  const [fareAmount, setFareAmount] = useState("");

  const [distanceFromId, setDistanceFromId] = useState("");
  const [distanceToId, setDistanceToId] = useState("");
  const [distanceKm, setDistanceKm] = useState("");

  const [driversOpen, setDriversOpen] = useState(false);
  const [vehiclesOpen, setVehiclesOpen] = useState(false);
  const [locationsOpen, setLocationsOpen] = useState(false);
  const [faresOpen, setFaresOpen] = useState(false);
  const [distancesOpen, setDistancesOpen] = useState(false);

  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("pickup_admin_key") : "";
    if (saved) {
      setAdminKey(saved);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (adminKey.trim()) {
      localStorage.setItem("pickup_admin_key", adminKey.trim());
    }
  }, [adminKey]);

  const locationNameMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const l of locations) {
      map.set(l.id, l.name);
    }
    return map;
  }, [locations]);

  async function loadDrivers(key: string) {
    const res = await fetch("/api/admin/drivers", {
      headers: { "x-admin-key": key },
    });
    const json = await readJsonOrThrow(res);
    setDrivers(normalizeItems<DriverRow>(json));
  }

  async function loadVehicles(key: string) {
    const res = await fetch("/api/admin/vehicles", {
      headers: { "x-admin-key": key },
    });
    const json = await readJsonOrThrow(res);
    setVehicles(normalizeItems<VehicleRow>(json));
  }

  async function loadLocations(key: string) {
    const res = await fetch("/api/admin/locations", {
      headers: { "x-admin-key": key },
    });
    const json = await readJsonOrThrow(res);
    setLocations(normalizeItems<LocationRow>(json));
  }

  async function loadFares(key: string) {
    const res = await fetch("/api/admin/fares", {
      headers: { "x-admin-key": key },
    });
    const json = await readJsonOrThrow(res);
    setFares(normalizeItems<FareRow>(json));
  }

  async function loadRouteDistances(key: string) {
    const res = await fetch("/api/admin/route-distances", {
      headers: { "x-admin-key": key },
    });
    const json = await readJsonOrThrow(res);
    setRouteDistances(normalizeItems<RouteDistanceRow>(json));
  }

  async function reloadAll() {
    const key = adminKey.trim();
    if (!key) {
      alert("パスワードを入力してください");
      return;
    }

    setLoading(true);
    setStatusText("読み込み中…");

    try {
      await Promise.all([
        loadDrivers(key),
        loadVehicles(key),
        loadLocations(key),
        loadFares(key),
        loadRouteDistances(key),
      ]);
      setStatusText("再読み込みしました");
    } catch (error) {
      const msg = getErrorMessage(error, "再読み込みに失敗しました");
      setStatusText(msg);
      alert(msg);
    } finally {
      setLoading(false);
    }
  }

  async function postJson(url: string, body: Record<string, unknown>) {
    const key = adminKey.trim();
    if (!key) throw new Error("パスワードを入力してください");

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-key": key,
      },
      body: JSON.stringify(body),
    });

    return await readJsonOrThrow(res);
  }

  async function deleteJson(url: string, body: Record<string, unknown>) {
    const key = adminKey.trim();
    if (!key) throw new Error("パスワードを入力してください");

    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "x-admin-key": key,
      },
      body: JSON.stringify(body),
    });

    return await readJsonOrThrow(res);
  }

  async function handleAddDriver() {
    if (!driverName.trim()) {
      alert("運転手名を入力してください");
      return;
    }

    try {
      setLoading(true);
      setStatusText("運転手を保存中…");
      await postJson("/api/admin/drivers", { name: driverName.trim() });
      setDriverName("");
      await loadDrivers(adminKey.trim());
      setStatusText("運転手を追加しました");
    } catch (error) {
      const msg = getErrorMessage(error, "運転手の追加に失敗しました");
      setStatusText(msg);
      alert(msg);
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteDriver(id: number) {
    if (!window.confirm("この運転手を削除しますか？")) return;

    try {
      setLoading(true);
      setStatusText("運転手を削除中…");
      await deleteJson("/api/admin/drivers", { id });
      await loadDrivers(adminKey.trim());
      setStatusText("運転手を削除しました");
    } catch (error) {
      const msg = getErrorMessage(error, "運転手の削除に失敗しました");
      setStatusText(msg);
      alert(msg);
    } finally {
      setLoading(false);
    }
  }

  async function handleAddVehicle() {
    if (!vehicleName.trim()) {
      alert("車両名を入力してください");
      return;
    }

    try {
      setLoading(true);
      setStatusText("車両を保存中…");
      await postJson("/api/admin/vehicles", { name: vehicleName.trim() });
      setVehicleName("");
      await loadVehicles(adminKey.trim());
      setStatusText("車両を追加しました");
    } catch (error) {
      const msg = getErrorMessage(error, "車両の追加に失敗しました");
      setStatusText(msg);
      alert(msg);
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteVehicle(id: number) {
    if (!window.confirm("この車両を削除しますか？")) return;

    try {
      setLoading(true);
      setStatusText("車両を削除中…");
      await deleteJson("/api/admin/vehicles", { id });
      await loadVehicles(adminKey.trim());
      setStatusText("車両を削除しました");
    } catch (error) {
      const msg = getErrorMessage(error, "車両の削除に失敗しました");
      setStatusText(msg);
      alert(msg);
    } finally {
      setLoading(false);
    }
  }

  async function handleAddLocation() {
    if (!locationName.trim()) {
      alert("地点名を入力してください");
      return;
    }

    try {
      setLoading(true);
      setStatusText("地点を保存中…");
      await postJson("/api/admin/locations", { name: locationName.trim() });
      setLocationName("");
      await loadLocations(adminKey.trim());
      setStatusText("地点を追加しました");
    } catch (error) {
      const msg = getErrorMessage(error, "地点の追加に失敗しました");
      setStatusText(msg);
      alert(msg);
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteLocation(id: number) {
    if (!window.confirm("この地点を削除しますか？")) return;

    try {
      setLoading(true);
      setStatusText("地点を削除中…");
      await deleteJson("/api/admin/locations", { id });
      await loadLocations(adminKey.trim());
      setStatusText("地点を削除しました");
    } catch (error) {
      const msg = getErrorMessage(error, "地点の削除に失敗しました");
      setStatusText(msg);
      alert(msg);
    } finally {
      setLoading(false);
    }
  }

  async function handleUpsertFare() {
    if (!fareFromId || !fareToId) {
      alert("出発地と到着地を選択してください");
      return;
    }

    if (fareAmount.trim() === "") {
      alert("金額を入力してください");
      return;
    }

    const amount = Number(fareAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      alert("金額は0以上の数値で入力してください");
      return;
    }

    try {
      setLoading(true);
      setStatusText("区間運賃を保存中…");
      await postJson("/api/admin/fares", {
        from_id: Number(fareFromId),
        to_id: Number(fareToId),
        amount_yen: amount,
      });
      setFareFromId("");
      setFareToId("");
      setFareAmount("");
      await loadFares(adminKey.trim());
      setStatusText("区間運賃を保存しました");
    } catch (error) {
      const msg = getErrorMessage(error, "区間運賃の保存に失敗しました");
      setStatusText(msg);
      alert(msg);
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteFare(id: number) {
    if (!window.confirm("この区間運賃を削除しますか？")) return;

    try {
      setLoading(true);
      setStatusText("区間運賃を削除中…");
      await deleteJson("/api/admin/fares", { id });
      await loadFares(adminKey.trim());
      setStatusText("区間運賃を削除しました");
    } catch (error) {
      const msg = getErrorMessage(error, "区間運賃の削除に失敗しました");
      setStatusText(msg);
      alert(msg);
    } finally {
      setLoading(false);
    }
  }

  async function handleUpsertRouteDistance() {
    if (!distanceFromId || !distanceToId) {
      alert("出発地と到着地を選択してください");
      return;
    }

    if (distanceFromId === distanceToId) {
      alert("同じ地点同士は登録できません");
      return;
    }

    if (distanceKm.trim() === "") {
      alert("距離を入力してください");
      return;
    }

    const km = Number(distanceKm);
    if (!Number.isFinite(km) || km < 0) {
      alert("距離は0以上の数値で入力してください");
      return;
    }

    try {
      setLoading(true);
      setStatusText("距離相場を保存中…");
      await postJson("/api/admin/route-distances", {
        from_location_id: Number(distanceFromId),
        to_location_id: Number(distanceToId),
        distance_km: km,
      });
      setDistanceFromId("");
      setDistanceToId("");
      setDistanceKm("");
      await loadRouteDistances(adminKey.trim());
      setStatusText("距離相場を保存しました");
    } catch (error) {
      const msg = getErrorMessage(error, "距離相場の保存に失敗しました");
      setStatusText(msg);
      alert(msg);
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteRouteDistance(id: number) {
    if (!window.confirm("この距離相場を削除しますか？")) return;

    try {
      setLoading(true);
      setStatusText("距離相場を削除中…");
      await deleteJson("/api/admin/route-distances", { id });
      await loadRouteDistances(adminKey.trim());
      setStatusText("距離相場を削除しました");
    } catch (error) {
      const msg = getErrorMessage(error, "距離相場の削除に失敗しました");
      setStatusText(msg);
      alert(msg);
    } finally {
      setLoading(false);
    }
  }

  function renderSimpleList<T extends { id: number; name: string }>(
    items: T[],
    onDelete: (id: number) => void,
    emptyText: string
  ) {
    if (items.length === 0) {
      return (
        <div style={{ ...styles.itemCard, opacity: 0.72 }}>
          <div style={styles.itemMeta}>
            <div style={styles.itemTitle}>{emptyText}</div>
          </div>
        </div>
      );
    }

    return items.map((item) => (
      <div key={item.id} style={styles.itemCard}>
        <div style={styles.itemMeta}>
          <div style={styles.itemTitle}>{item.name}</div>
          <div style={styles.itemSub}>ID: {item.id}</div>
        </div>

        <button style={styles.dangerBtn} onClick={() => onDelete(item.id)} type="button">
          削除
        </button>
      </div>
    ));
  }

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <div style={styles.topbar}>
          <h1 style={styles.title}>管理ページ</h1>
          <Link href="/" style={styles.ghostLink}>
            ← 入力ページへ
          </Link>
        </div>

        <div style={styles.card}>
          <h2 style={{ ...styles.sectionTitle, fontSize: 26, marginBottom: 18 }}>設定</h2>

          <div style={styles.row}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>パスワード</div>
              <input
                type="password"
                value={adminKey}
                onChange={(e) => setAdminKey(e.target.value)}
                placeholder="ADMIN_KEY"
                style={styles.input}
              />
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button type="button" style={styles.secondaryBtn} onClick={reloadAll} disabled={loading}>
                再読み込み
              </button>
            </div>

            {!!statusText && <div style={styles.status}>{statusText}</div>}
          </div>

          <hr style={styles.hr} />

          <div style={styles.row}>
            <h3 style={styles.sectionTitle}>運転手を追加</h3>
            <input
              type="text"
              value={driverName}
              onChange={(e) => setDriverName(e.target.value)}
              placeholder="運転手名"
              style={styles.input}
            />
            <div>
              <button type="button" style={styles.primaryBtn} onClick={handleAddDriver} disabled={loading}>
                追加
              </button>
            </div>
          </div>

          <hr style={styles.hr} />

          <div style={styles.row}>
            <h3 style={styles.sectionTitle}>車両を追加</h3>
            <input
              type="text"
              value={vehicleName}
              onChange={(e) => setVehicleName(e.target.value)}
              placeholder="車両名"
              style={styles.input}
            />
            <div>
              <button type="button" style={styles.primaryBtn} onClick={handleAddVehicle} disabled={loading}>
                追加
              </button>
            </div>
          </div>

          <hr style={styles.hr} />

          <div style={styles.row}>
            <h3 style={styles.sectionTitle}>地点を追加</h3>
            <input
              type="text"
              value={locationName}
              onChange={(e) => setLocationName(e.target.value)}
              placeholder="地点名"
              style={styles.input}
            />
            <div>
              <button type="button" style={styles.primaryBtn} onClick={handleAddLocation} disabled={loading}>
                追加
              </button>
            </div>
          </div>

          <hr style={styles.hr} />

          <div style={styles.row}>
            <h3 style={styles.sectionTitle}>区間運賃を追加 / 更新</h3>

            <select
              value={fareFromId}
              onChange={(e) => setFareFromId(e.target.value)}
              style={styles.select}
            >
              <option value="">出発地を選択</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))}
            </select>

            <select value={fareToId} onChange={(e) => setFareToId(e.target.value)} style={styles.select}>
              <option value="">到着地を選択</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))}
            </select>

            <input
              type="number"
              min="0"
              step="1"
              value={fareAmount}
              onChange={(e) => setFareAmount(e.target.value)}
              placeholder="金額（円）"
              style={styles.input}
            />

            <div>
              <button type="button" style={styles.primaryBtn} onClick={handleUpsertFare} disabled={loading}>
                追加 / 更新
              </button>
            </div>
          </div>

          <hr style={styles.hr} />

          <div style={styles.row}>
            <h3 style={styles.sectionTitle}>区間距離を追加 / 更新</h3>

            <select
              value={distanceFromId}
              onChange={(e) => setDistanceFromId(e.target.value)}
              style={styles.select}
            >
              <option value="">出発地を選択</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))}
            </select>

            <select
              value={distanceToId}
              onChange={(e) => setDistanceToId(e.target.value)}
              style={styles.select}
            >
              <option value="">到着地を選択</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))}
            </select>

            <input
              type="number"
              min="0"
              step="0.1"
              value={distanceKm}
              onChange={(e) => setDistanceKm(e.target.value)}
              placeholder="距離（km）"
              style={styles.input}
            />

            <div>
              <button
                type="button"
                style={styles.primaryBtn}
                onClick={handleUpsertRouteDistance}
                disabled={loading}
              >
                追加 / 更新
              </button>
            </div>

            <div style={styles.helper}>
              片方向だけ登録しても、入力ページ側では逆方向も同じ距離として扱う想定。
            </div>
          </div>

          <hr style={styles.hr} />

          <div style={{ display: "grid", gap: 12 }}>
            <button
              type="button"
              style={styles.collapsibleBtn}
              onClick={() => setDriversOpen((v) => !v)}
            >
              <span style={{ fontWeight: 800, fontSize: 18 }}>運転手一覧</span>
              <span style={{ opacity: 0.72 }}>{driversOpen ? "閉じる" : "開く"}</span>
            </button>
            {driversOpen && (
              <div style={{ display: "grid", gap: 10 }}>
                {renderSimpleList(drivers, handleDeleteDriver, "まだ運転手はありません")}
              </div>
            )}

            <button
              type="button"
              style={styles.collapsibleBtn}
              onClick={() => setVehiclesOpen((v) => !v)}
            >
              <span style={{ fontWeight: 800, fontSize: 18 }}>車両一覧</span>
              <span style={{ opacity: 0.72 }}>{vehiclesOpen ? "閉じる" : "開く"}</span>
            </button>
            {vehiclesOpen && (
              <div style={{ display: "grid", gap: 10 }}>
                {renderSimpleList(vehicles, handleDeleteVehicle, "まだ車両はありません")}
              </div>
            )}

            <button
              type="button"
              style={styles.collapsibleBtn}
              onClick={() => setLocationsOpen((v) => !v)}
            >
              <span style={{ fontWeight: 800, fontSize: 18 }}>地点一覧</span>
              <span style={{ opacity: 0.72 }}>{locationsOpen ? "閉じる" : "開く"}</span>
            </button>
            {locationsOpen && (
              <div style={{ display: "grid", gap: 10 }}>
                {locations.length === 0 ? (
                  <div style={{ ...styles.itemCard, opacity: 0.72 }}>
                    <div style={styles.itemMeta}>
                      <div style={styles.itemTitle}>まだ地点はありません</div>
                    </div>
                  </div>
                ) : (
                  locations.map((item) => (
                    <div key={item.id} style={styles.itemCard}>
                      <div style={styles.itemMeta}>
                        <div style={styles.itemTitle}>{item.name}</div>
                        <div style={styles.itemSub}>
                          ID: {item.id}
                          {item.kind ? ` / 種別: ${item.kind}` : ""}
                        </div>
                      </div>

                      <button
                        style={styles.dangerBtn}
                        onClick={() => handleDeleteLocation(item.id)}
                        type="button"
                      >
                        削除
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}

            <button
              type="button"
              style={styles.collapsibleBtn}
              onClick={() => setFaresOpen((v) => !v)}
            >
              <span style={{ fontWeight: 800, fontSize: 18 }}>区間運賃一覧</span>
              <span style={{ opacity: 0.72 }}>{faresOpen ? "閉じる" : "開く"}</span>
            </button>
            {faresOpen && (
              <div style={{ display: "grid", gap: 10 }}>
                {fares.length === 0 ? (
                  <div style={{ ...styles.itemCard, opacity: 0.72 }}>
                    <div style={styles.itemMeta}>
                      <div style={styles.itemTitle}>まだ区間運賃はありません</div>
                    </div>
                  </div>
                ) : (
                  fares.map((row) => (
                    <div key={row.id} style={styles.itemCard}>
                      <div style={styles.itemMeta}>
                        <div style={styles.itemTitle}>
                          {locationNameMap.get(row.from_id) ?? row.from_id} →{" "}
                          {locationNameMap.get(row.to_id) ?? row.to_id}
                        </div>
                        <div style={styles.itemSub}>
                          {row.amount_yen} 円 / ID: {row.id}
                        </div>
                      </div>

                      <button
                        style={styles.dangerBtn}
                        onClick={() => handleDeleteFare(row.id)}
                        type="button"
                      >
                        削除
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}

            <button
              type="button"
              style={styles.collapsibleBtn}
              onClick={() => setDistancesOpen((v) => !v)}
            >
              <span style={{ fontWeight: 800, fontSize: 18 }}>距離相場一覧</span>
              <span style={{ opacity: 0.72 }}>{distancesOpen ? "閉じる" : "開く"}</span>
            </button>
            {distancesOpen && (
              <div style={{ display: "grid", gap: 10 }}>
                {routeDistances.length === 0 ? (
                  <div style={{ ...styles.itemCard, opacity: 0.72 }}>
                    <div style={styles.itemMeta}>
                      <div style={styles.itemTitle}>まだ距離相場はありません</div>
                    </div>
                  </div>
                ) : (
                  routeDistances.map((row) => (
                    <div key={row.id} style={styles.itemCard}>
                      <div style={styles.itemMeta}>
                        <div style={styles.itemTitle}>
                          {row.from_location?.name ??
                            locationNameMap.get(row.from_location_id) ??
                            row.from_location_id}{" "}
                          →{" "}
                          {row.to_location?.name ??
                            locationNameMap.get(row.to_location_id) ??
                            row.to_location_id}
                        </div>
                        <div style={styles.itemSub}>
                          {row.distance_km} km / ID: {row.id}
                        </div>
                      </div>

                      <button
                        style={styles.dangerBtn}
                        onClick={() => handleDeleteRouteDistance(row.id)}
                        type="button"
                      >
                        削除
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
