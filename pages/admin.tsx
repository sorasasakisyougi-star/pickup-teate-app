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

const styles = {
  page: {
    minHeight: "100vh",
    background:
      "radial-gradient(circle at top, rgba(40,56,120,0.18), transparent 28%), #05070b",
    color: "#f3f6ff",
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    padding: "20px 14px 56px",
    boxSizing: "border-box" as const,
  } as const,

  wrap: {
    maxWidth: 1080,
    margin: "0 auto",
  } as const,

  title: {
    fontSize: "clamp(34px, 7vw, 44px)",
    fontWeight: 800,
    letterSpacing: "-0.03em",
    margin: 0,
  } as const,

  grid: {
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: 18,
    marginTop: 22,
  } as const,

  section: {
    background: "rgba(12,16,24,0.92)",
    border: "1px solid rgba(110,130,190,0.18)",
    borderRadius: 22,
    padding: 18,
    boxShadow: "0 20px 50px rgba(0,0,0,0.35)",
  } as const,

  sectionTitle: {
    fontSize: 28,
    fontWeight: 800,
    margin: "0 0 18px",
  } as const,

  subTitle: {
    fontSize: 18,
    fontWeight: 700,
    margin: "0 0 12px",
  } as const,

  label: {
    display: "block",
    fontSize: 13,
    color: "#aeb7cb",
    marginBottom: 8,
    fontWeight: 700,
  } as const,

  column: {
    display: "grid",
    gap: 10,
  } as const,

  input: {
    width: "100%",
    height: 46,
    borderRadius: 12,
    border: "1px solid rgba(107,125,172,0.28)",
    background: "#090c12",
    color: "#f5f7ff",
    padding: "0 14px",
    outline: "none",
    fontSize: 14,
    boxSizing: "border-box" as const,
  } as const,

  select: {
    width: "100%",
    height: 46,
    borderRadius: 12,
    border: "1px solid rgba(107,125,172,0.28)",
    background: "#090c12",
    color: "#f5f7ff",
    padding: "0 14px",
    outline: "none",
    fontSize: 14,
    boxSizing: "border-box" as const,
  } as const,

  buttonPrimary: {
    height: 46,
    borderRadius: 12,
    border: "1px solid rgba(84,114,220,0.5)",
    background: "#19327e",
    color: "#ffffff",
    padding: "0 16px",
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  } as const,

  buttonGhost: {
    height: 40,
    borderRadius: 10,
    border: "1px solid rgba(107,125,172,0.24)",
    background: "#131821",
    color: "#eef2ff",
    padding: "0 14px",
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  } as const,

  buttonDanger: {
    height: 32,
    borderRadius: 10,
    border: "1px solid rgba(220,90,90,0.28)",
    background: "rgba(120,28,28,0.22)",
    color: "#ffd9d9",
    padding: "0 10px",
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
    flexShrink: 0 as const,
  } as const,

  muted: {
    color: "#96a0b8",
    fontSize: 13,
  } as const,

  error: {
    marginTop: 14,
    background: "rgba(150,38,38,0.18)",
    color: "#ffd1d1",
    border: "1px solid rgba(220,90,90,0.28)",
    borderRadius: 14,
    padding: "12px 14px",
    fontWeight: 700,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
  } as const,

  success: {
    marginTop: 14,
    background: "rgba(40,110,70,0.18)",
    color: "#d9ffe8",
    border: "1px solid rgba(82,180,118,0.28)",
    borderRadius: 14,
    padding: "12px 14px",
    fontWeight: 700,
  } as const,

  cardList: {
    display: "grid",
    gap: 10,
    marginTop: 14,
  } as const,

  itemCard: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    padding: "14px",
    borderRadius: 16,
    background: "#0a0d14",
    border: "1px solid rgba(107,125,172,0.15)",
  } as const,

  itemMain: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
    minWidth: 0,
    flex: 1,
  },

  itemTitle: {
    fontWeight: 700,
    fontSize: 15,
    color: "#f5f7ff",
    wordBreak: "break-word" as const,
    lineHeight: 1.5,
  } as const,

  badgeWrap: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap" as const,
  } as const,

  badge: {
    display: "inline-flex",
    alignItems: "center",
    height: 24,
    padding: "0 10px",
    borderRadius: 999,
    background: "rgba(86,103,147,0.2)",
    border: "1px solid rgba(107,125,172,0.2)",
    color: "#c9d3ea",
    fontSize: 12,
    fontWeight: 700,
    width: "fit-content" as const,
  } as const,

  divider: {
    height: 1,
    background: "rgba(107,125,172,0.14)",
    margin: "18px 0",
  } as const,

  emptyBox: {
    marginTop: 12,
    padding: "16px 14px",
    borderRadius: 14,
    background: "#0a0d14",
    border: "1px dashed rgba(107,125,172,0.22)",
    color: "#98a3bb",
    fontSize: 14,
  } as const,

  accordionButton: {
    width: "100%",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 16px",
    borderRadius: 14,
    border: "1px solid rgba(107,125,172,0.18)",
    background: "#0a0d14",
    color: "#f5f7ff",
    cursor: "pointer",
    fontWeight: 800,
    fontSize: 16,
    textAlign: "left" as const,
  } as const,

  accordionBody: {
    marginTop: 12,
  } as const,
};

function Accordion({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button type="button" style={styles.accordionButton} onClick={onToggle}>
        <span>
          {title}
          <span style={{ ...styles.muted, marginLeft: 8 }}>{count}件</span>
        </span>
        <span>{open ? "▲" : "▼"}</span>
      </button>

      {open ? <div style={styles.accordionBody}>{children}</div> : null}
    </div>
  );
}

export default function AdminPage() {
  const [password, setPassword] = useState("");

  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [fares, setFares] = useState<FareRow[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [driverName, setDriverName] = useState("");
  const [locationName, setLocationName] = useState("");
  const [fareFromId, setFareFromId] = useState<string>("");
  const [fareToId, setFareToId] = useState<string>("");
  const [fareAmount, setFareAmount] = useState<string>("");

  const [openDrivers, setOpenDrivers] = useState(false);
  const [openLocations, setOpenLocations] = useState(false);
  const [openFares, setOpenFares] = useState(false);

  const canSaveFare = useMemo(() => {
    return !!fareFromId && !!fareToId && fareAmount.trim() !== "";
  }, [fareFromId, fareToId, fareAmount]);

  const sortedDrivers = useMemo(() => {
    return [...drivers].sort((a, b) => a.name.localeCompare(b.name, "ja"));
  }, [drivers]);

  const sortedLocations = useMemo(() => {
    return [...locations].sort((a, b) => a.name.localeCompare(b.name, "ja"));
  }, [locations]);

  const fareView = useMemo(() => {
    return [...fares]
      .map((fare) => ({
        ...fare,
        fromName:
          locations.find((x) => x.id === fare.from_id)?.name ?? String(fare.from_id),
        toName:
          locations.find((x) => x.id === fare.to_id)?.name ?? String(fare.to_id),
      }))
      .sort((a, b) => {
        const left = `${a.fromName}-${a.toName}`;
        const right = `${b.fromName}-${b.toName}`;
        return left.localeCompare(right, "ja");
      });
  }, [fares, locations]);

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

  async function reloadAll(showMessage = false) {
    setLoading(true);
    setError("");
    if (showMessage) setMessage("");

    try {
      const [driversData, locationsData, faresData] = await Promise.all([
        loadDrivers(),
        loadLocations(),
        loadFares(),
      ]);

      setDrivers(driversData);
      setLocations(locationsData);
      setFares(faresData);

      if (showMessage) {
        setMessage("再読み込みしました");
      }
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
    reloadAll(false);
  }, []);

  async function addDriver() {
    if (!driverName.trim()) return;

    try {
      setError("");
      setMessage("");

      const res = await fetch("/api/admin/drivers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-key": password,
        },
        body: JSON.stringify({ name: driverName.trim() }),
      });

      await readJsonOrThrow(res);
      setDriverName("");
      await reloadAll(false);
      setMessage("運転手を追加しました");
      setOpenDrivers(true);
    } catch (e) {
      console.error("[addDriver]", e);
      setError(e instanceof Error ? e.message : "運転手追加に失敗");
    }
  }

  async function deleteDriver(id: number) {
    if (!window.confirm("この運転手を削除しますか？")) return;

    try {
      setError("");
      setMessage("");

      const res = await fetch("/api/admin/drivers", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "x-admin-key": password,
        },
        body: JSON.stringify({ id }),
      });

      await readJsonOrThrow(res);
      await reloadAll(false);
      setMessage("運転手を削除しました");
    } catch (e) {
      console.error("[deleteDriver]", e);
      setError(e instanceof Error ? e.message : "運転手削除に失敗");
    }
  }

  async function addLocation() {
    if (!locationName.trim()) return;

    try {
      setError("");
      setMessage("");

      const res = await fetch("/api/admin/locations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-key": password,
        },
        body: JSON.stringify({
          name: locationName.trim(),
        }),
      });

      await readJsonOrThrow(res);
      setLocationName("");
      await reloadAll(false);
      setMessage("地点を追加しました");
      setOpenLocations(true);
    } catch (e) {
      console.error("[addLocation]", e);
      setError(e instanceof Error ? e.message : "地点追加に失敗");
    }
  }

  async function deleteLocation(id: number) {
    if (!window.confirm("この地点を削除しますか？")) return;

    try {
      setError("");
      setMessage("");

      const res = await fetch("/api/admin/locations", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "x-admin-key": password,
        },
        body: JSON.stringify({ id }),
      });

      await readJsonOrThrow(res);
      await reloadAll(false);
      setMessage("地点を削除しました");
    } catch (e) {
      console.error("[deleteLocation]", e);
      setError(e instanceof Error ? e.message : "地点削除に失敗");
    }
  }

  async function saveFare() {
    if (!canSaveFare) return;

    try {
      setError("");
      setMessage("");

      const res = await fetch("/api/admin/fares", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-key": password,
        },
        body: JSON.stringify({
          from_id: Number(fareFromId),
          to_id: Number(fareToId),
          amount_yen: Number(fareAmount),
        }),
      });

      await readJsonOrThrow(res);
      setFareAmount("");
      await reloadAll(false);
      setMessage("金額を追加 / 更新しました");
      setOpenFares(true);
    } catch (e) {
      console.error("[saveFare]", e);
      setError(e instanceof Error ? e.message : "金額保存に失敗");
    }
  }

  async function deleteFare(from_id: number, to_id: number) {
    if (!window.confirm("この区間運賃を削除しますか？")) return;

    try {
      setError("");
      setMessage("");

      const res = await fetch("/api/admin/fares", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "x-admin-key": password,
        },
        body: JSON.stringify({ from_id, to_id }),
      });

      await readJsonOrThrow(res);
      await reloadAll(false);
      setMessage("金額を削除しました");
    } catch (e) {
      console.error("[deleteFare]", e);
      setError(e instanceof Error ? e.message : "金額削除に失敗");
    }
  }

  return (
    <>
      <style jsx global>{`
        html,
        body,
        #__next {
          margin: 0;
          padding: 0;
          min-height: 100%;
          background: #05070b;
        }

        body {
          overflow-x: hidden;
        }
      `}</style>

      <main style={styles.page}>
        <div style={styles.wrap}>
          <h1 style={styles.title}>管理ページ</h1>

          {error ? <div style={styles.error}>{error}</div> : null}
          {!error && message ? <div style={styles.success}>{message}</div> : null}

          <div style={styles.grid}>
            <section style={styles.section}>
              <h2 style={styles.sectionTitle}>設定</h2>

              <label style={styles.label}>パスワード</label>
              <div style={styles.column}>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={styles.input}
                />
                <button
                  onClick={() => reloadAll(true)}
                  disabled={loading}
                  style={{
                    ...styles.buttonGhost,
                    width: "fit-content",
                    opacity: loading ? 0.6 : 1,
                    cursor: loading ? "not-allowed" : "pointer",
                  }}
                >
                  {loading ? "読込中..." : "再読み込み"}
                </button>
              </div>

              <div style={styles.divider} />

              <h3 style={styles.subTitle}>運転手を追加</h3>
              <div style={styles.column}>
                <input
                  value={driverName}
                  onChange={(e) => setDriverName(e.target.value)}
                  placeholder="運転手名"
                  style={styles.input}
                />
                <button
                  style={{ ...styles.buttonPrimary, width: "fit-content" }}
                  onClick={addDriver}
                >
                  追加
                </button>
              </div>

              <div style={styles.divider} />

              <h3 style={styles.subTitle}>地点を追加</h3>
              <div style={styles.column}>
                <input
                  value={locationName}
                  onChange={(e) => setLocationName(e.target.value)}
                  placeholder="地点名"
                  style={styles.input}
                />
                <button
                  style={{ ...styles.buttonPrimary, width: "fit-content" }}
                  onClick={addLocation}
                >
                  追加
                </button>
              </div>

              <div style={styles.divider} />

              <h3 style={styles.subTitle}>区間運賃を追加 / 更新</h3>
              <div style={styles.column}>
                <select
                  value={fareFromId}
                  onChange={(e) => setFareFromId(e.target.value)}
                  style={styles.select}
                >
                  <option value="">出発地を選択</option>
                  {sortedLocations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </select>

                <select
                  value={fareToId}
                  onChange={(e) => setFareToId(e.target.value)}
                  style={styles.select}
                >
                  <option value="">到着地を選択</option>
                  {sortedLocations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </select>

                <input
                  value={fareAmount}
                  onChange={(e) => setFareAmount(e.target.value)}
                  placeholder="金額（円）"
                  inputMode="numeric"
                  style={styles.input}
                />

                <button
                  style={{
                    ...styles.buttonPrimary,
                    width: "fit-content",
                    opacity: canSaveFare ? 1 : 0.55,
                    cursor: canSaveFare ? "pointer" : "not-allowed",
                  }}
                  onClick={saveFare}
                  disabled={!canSaveFare}
                >
                  追加 / 更新
                </button>
              </div>

              <div style={{ marginTop: 14, ...styles.muted }}>
                書き込み系はパスワードが一致した時だけ動く
              </div>

              <div style={styles.divider} />

              <h2 style={styles.sectionTitle}>一覧</h2>

              <Accordion
                title="運転手一覧"
                count={sortedDrivers.length}
                open={openDrivers}
                onToggle={() => setOpenDrivers((v) => !v)}
              >
                {sortedDrivers.length === 0 ? (
                  <div style={styles.emptyBox}>まだ運転手がありません</div>
                ) : (
                  <div style={styles.cardList}>
                    {sortedDrivers.map((d) => (
                      <div key={d.id} style={styles.itemCard}>
                        <div style={styles.itemMain}>
                          <div style={styles.itemTitle}>{d.name}</div>
                          <div style={styles.badge}>driver #{d.id}</div>
                        </div>
                        <button
                          style={styles.buttonDanger}
                          onClick={() => deleteDriver(d.id)}
                        >
                          削除
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </Accordion>

              <div style={styles.divider} />

              <Accordion
                title="地点一覧"
                count={sortedLocations.length}
                open={openLocations}
                onToggle={() => setOpenLocations((v) => !v)}
              >
                {sortedLocations.length === 0 ? (
                  <div style={styles.emptyBox}>まだ地点がありません</div>
                ) : (
                  <div style={styles.cardList}>
                    {sortedLocations.map((loc) => (
                      <div key={loc.id} style={styles.itemCard}>
                        <div style={styles.itemMain}>
                          <div style={styles.itemTitle}>{loc.name}</div>
                          <div style={styles.badgeWrap}>
                            <div style={styles.badge}>location #{loc.id}</div>
                          </div>
                        </div>
                        <button
                          style={styles.buttonDanger}
                          onClick={() => deleteLocation(loc.id)}
                        >
                          削除
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </Accordion>

              <div style={styles.divider} />

              <Accordion
                title="金額一覧"
                count={fareView.length}
                open={openFares}
                onToggle={() => setOpenFares((v) => !v)}
              >
                {fareView.length === 0 ? (
                  <div style={styles.emptyBox}>まだ区間運賃がありません</div>
                ) : (
                  <div style={styles.cardList}>
                    {fareView.map((fare, idx) => (
                      <div key={`${fare.from_id}-${fare.to_id}-${idx}`} style={styles.itemCard}>
                        <div style={styles.itemMain}>
                          <div style={styles.itemTitle}>
                            {fare.fromName} → {fare.toName}
                          </div>
                          <div style={styles.badgeWrap}>
                            <div style={styles.badge}>{fare.amount_yen}円</div>
                            <div style={styles.badge}>
                              {fare.from_id} → {fare.to_id}
                            </div>
                          </div>
                        </div>
                        <button
                          style={styles.buttonDanger}
                          onClick={() => deleteFare(fare.from_id, fare.to_id)}
                        >
                          削除
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </Accordion>
            </section>
          </div>
        </div>
      </main>
    </>
  );
}
