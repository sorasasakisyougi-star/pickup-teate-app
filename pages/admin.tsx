import { useEffect, useMemo, useState } from "react";

type DriverRow = {
  id: number;
  name: string;
};

type LocationRow = {
  id: number;
  name: string;
  kind?: string | null;
};

type FareRow = {
  id?: number;
  from_id: number;
  to_id: number;
  amount_yen: number;
};

async function readJsonOrThrow(res: Response) {
  const text = await res.text();

  if (!res.ok) {
    throw new Error(text || `HTTP ${res.status}`);
  }

  if (!text) return [];
  return JSON.parse(text);
}

export default function AdminPage() {
  const [adminKey, setAdminKey] = useState("");

  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [fares, setFares] = useState<FareRow[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [driverName, setDriverName] = useState("");
  const [locationName, setLocationName] = useState("");
  const [locationKind, setLocationKind] = useState("");
  const [fareFromId, setFareFromId] = useState<string>("");
  const [fareToId, setFareToId] = useState<string>("");
  const [fareAmount, setFareAmount] = useState<string>("");

  const canSaveFare = useMemo(() => {
    return !!fareFromId && !!fareToId && fareAmount.trim() !== "";
  }, [fareFromId, fareToId, fareAmount]);

  async function loadDrivers() {
    const res = await fetch("/api/admin/drivers");
    const data = await readJsonOrThrow(res);
    return Array.isArray(data) ? data : [];
  }

  async function loadLocations() {
    const res = await fetch("/api/admin/locations");
    const data = await readJsonOrThrow(res);
    return Array.isArray(data) ? data : [];
  }

  async function loadFares() {
    const res = await fetch("/api/admin/fares");
    const data = await readJsonOrThrow(res);
    return Array.isArray(data) ? data : [];
  }

  async function reloadAll() {
    setLoading(true);
    setError("");

    try {
      const [driversData, locationsData, faresData] = await Promise.all([
        loadDrivers(),
        loadLocations(),
        loadFares(),
      ]);

      setDrivers(driversData);
      setLocations(locationsData);
      setFares(faresData);
      setError("");
    } catch (e) {
      console.error("[admin reloadAll]", e);
      setDrivers([]);
      setLocations([]);
      setFares([]);
      setError(e instanceof Error ? e.message : "load failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reloadAll();
  }, []);

  async function addDriver() {
    if (!driverName.trim()) return;

    try {
      setError("");

      const res = await fetch("/api/admin/drivers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-key": adminKey,
        },
        body: JSON.stringify({ name: driverName.trim() }),
      });

      await readJsonOrThrow(res);
      setDriverName("");
      await reloadAll();
    } catch (e) {
      console.error("[addDriver]", e);
      setError(e instanceof Error ? e.message : "運転手追加に失敗");
    }
  }

  async function deleteDriver(id: number) {
    try {
      setError("");

      const res = await fetch("/api/admin/drivers", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "x-admin-key": adminKey,
        },
        body: JSON.stringify({ id }),
      });

      await readJsonOrThrow(res);
      await reloadAll();
    } catch (e) {
      console.error("[deleteDriver]", e);
      setError(e instanceof Error ? e.message : "運転手削除に失敗");
    }
  }

  async function addLocation() {
    if (!locationName.trim()) return;

    try {
      setError("");

      const res = await fetch("/api/admin/locations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-key": adminKey,
        },
        body: JSON.stringify({
          name: locationName.trim(),
          kind: locationKind.trim() || null,
        }),
      });

      await readJsonOrThrow(res);
      setLocationName("");
      setLocationKind("");
      await reloadAll();
    } catch (e) {
      console.error("[addLocation]", e);
      setError(e instanceof Error ? e.message : "地点追加に失敗");
    }
  }

  async function deleteLocation(id: number) {
    try {
      setError("");

      const res = await fetch("/api/admin/locations", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "x-admin-key": adminKey,
        },
        body: JSON.stringify({ id }),
      });

      await readJsonOrThrow(res);
      await reloadAll();
    } catch (e) {
      console.error("[deleteLocation]", e);
      setError(e instanceof Error ? e.message : "地点削除に失敗");
    }
  }

  async function saveFare() {
    if (!canSaveFare) return;

    try {
      setError("");

      const res = await fetch("/api/admin/fares", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-key": adminKey,
        },
        body: JSON.stringify({
          from_id: Number(fareFromId),
          to_id: Number(fareToId),
          amount_yen: Number(fareAmount),
        }),
      });

      await readJsonOrThrow(res);
      setFareAmount("");
      await reloadAll();
    } catch (e) {
      console.error("[saveFare]", e);
      setError(e instanceof Error ? e.message : "金額保存に失敗");
    }
  }

  async function deleteFare(from_id: number, to_id: number) {
    try {
      setError("");

      const res = await fetch("/api/admin/fares", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "x-admin-key": adminKey,
        },
        body: JSON.stringify({ from_id, to_id }),
      });

      await readJsonOrThrow(res);
      await reloadAll();
    } catch (e) {
      console.error("[deleteFare]", e);
      setError(e instanceof Error ? e.message : "金額削除に失敗");
    }
  }

  return (
    <main style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1 style={{ fontSize: 40, marginBottom: 24 }}>管理ページ</h1>

      <div style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 8, fontWeight: 700 }}>ADMIN_KEY</div>
        <input
          type="password"
          value={adminKey}
          onChange={(e) => setAdminKey(e.target.value)}
          placeholder="VercelのADMIN_KEY"
          style={{ width: 280, marginRight: 8 }}
        />
        <button onClick={reloadAll} disabled={loading}>
          {loading ? "読込中..." : "再読み込み"}
        </button>
      </div>

      {error ? (
        <div style={{ marginBottom: 16, color: "crimson", fontWeight: 700 }}>
          {error}
        </div>
      ) : null}

      <section style={{ marginBottom: 28 }}>
        <h2>運転手</h2>

        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input
            value={driverName}
            onChange={(e) => setDriverName(e.target.value)}
            placeholder="運転手名"
          />
          <button onClick={addDriver}>追加</button>
        </div>

        <ul>
          {drivers.map((d) => (
            <li key={d.id} style={{ marginBottom: 6 }}>
              {d.name}{" "}
              <button onClick={() => deleteDriver(d.id)}>削除</button>
            </li>
          ))}
        </ul>
      </section>

      <section style={{ marginBottom: 28 }}>
        <h2>地点</h2>

        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <input
            value={locationName}
            onChange={(e) => setLocationName(e.target.value)}
            placeholder="地点名"
          />
          <input
            value={locationKind}
            onChange={(e) => setLocationKind(e.target.value)}
            placeholder="kind（任意）"
          />
          <button onClick={addLocation}>追加</button>
        </div>

        <ul>
          {locations.map((loc) => (
            <li key={loc.id} style={{ marginBottom: 6 }}>
              {loc.name}
              {loc.kind ? ` / ${loc.kind}` : ""}{" "}
              <button onClick={() => deleteLocation(loc.id)}>削除</button>
            </li>
          ))}
        </ul>
      </section>

      <section style={{ marginBottom: 28 }}>
        <h2>金額（区間運賃）</h2>

        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <select value={fareFromId} onChange={(e) => setFareFromId(e.target.value)}>
            <option value="">from</option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </select>

          <select value={fareToId} onChange={(e) => setFareToId(e.target.value)}>
            <option value="">to</option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </select>

          <input
            value={fareAmount}
            onChange={(e) => setFareAmount(e.target.value)}
            placeholder="円"
            inputMode="numeric"
          />

          <button onClick={saveFare} disabled={!canSaveFare}>
            追加/更新
          </button>
        </div>

        <ul>
          {fares.map((fare, idx) => {
            const from = locations.find((x) => x.id === fare.from_id)?.name ?? fare.from_id;
            const to = locations.find((x) => x.id === fare.to_id)?.name ?? fare.to_id;

            return (
              <li key={`${fare.from_id}-${fare.to_id}-${idx}`} style={{ marginBottom: 6 }}>
                {String(from)} → {String(to)} : {fare.amount_yen}円{" "}
                <button onClick={() => deleteFare(fare.from_id, fare.to_id)}>削除</button>
              </li>
            );
          })}
        </ul>
      </section>

      <div>注意：書き込みは ADMIN_KEY が一致した時だけ動く（安全）</div>
    </main>
  );
}
