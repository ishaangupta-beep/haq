// Minimal in-memory stand-in for the parts of supabase-js the workflow uses.
type Row = Record<string, any>;

export function fakeSupabase() {
  const tables: Record<string, Row[]> = { cases: [], calls: [], case_events: [] };
  let seq = 0;
  const newId = () => `id-${++seq}`;

  function from(table: string) {
    const rows = (tables[table] ??= []);
    let op: "select" | "insert" | "update" | "upsert" = "select";
    let payload: Row | null = null;
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    const filters: ((r: Row) => boolean)[] = [];
    let wantRows = false;

    const matches = () => rows.filter((r) => filters.every((f) => f(r)));

    const run = (): { data: Row[]; error: null } => {
      if (op === "select") return { data: matches(), error: null };
      if (op === "insert") {
        const r: Row = { id: table === "case_events" ? ++seq : newId(), created_at: new Date().toISOString(), ...payload };
        if (table === "cases") r.status ??= "intake_done";
        rows.push(r);
        return { data: [r], error: null };
      }
      if (op === "update") {
        const hit = matches();
        hit.forEach((r) => Object.assign(r, payload));
        return { data: hit, error: null };
      }
      // upsert
      const key = upsertOpts.onConflict!;
      const found = rows.find((r) => r[key] === payload![key]);
      if (found) {
        if (!upsertOpts.ignoreDuplicates) Object.assign(found, payload);
        return { data: [found], error: null };
      }
      const r = { id: newId(), created_at: new Date().toISOString(), processed_at: null, case_id: null, ...payload };
      rows.push(r);
      return { data: [r], error: null };
    };

    const b: any = {
      select: () => ((wantRows = true), b),
      insert: (p: Row) => ((op = "insert"), (payload = p), b),
      update: (p: Row) => ((op = "update"), (payload = p), b),
      upsert: (p: Row, o: any) => ((op = "upsert"), (payload = p), (upsertOpts = o ?? {}), b),
      eq: (k: string, v: any) => (filters.push((r) => r[k] === v), b),
      is: (k: string, v: any) => (filters.push((r) => (r[k] ?? null) === v), b),
      order: () => b,
      limit: () => b,
      single: async () => {
        const { data } = run();
        return data[0] ? { data: { ...data[0] }, error: null } : { data: null, error: { message: "not found" } };
      },
      maybeSingle: async () => {
        const { data } = run();
        return { data: data[0] ? { ...data[0] } : null, error: null };
      },
      then: (res: any, rej: any) => Promise.resolve(run()).then((r) => ({ ...r, data: wantRows ? r.data : null })).then(res, rej),
    };
    return b;
  }

  return { client: { from } as any, tables };
}
