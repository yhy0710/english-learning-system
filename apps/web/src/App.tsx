import { useEffect, useMemo, useState } from "react";
import { Activity, BookOpen, Database, Download, FileUp, HeartPulse, RefreshCw, Search, Server, Trash2, Wifi } from "lucide-react";
import type { CsvImportReport, DueCard, LearningStats, PairingResponse, ResourcePack, ReviewRating, Word, WordInput } from "@els/shared";
import { api } from "./api";

type Tab = "review" | "words" | "csv" | "resources" | "sync";

const emptyStats: LearningStats = {
  totalWords: 0,
  dueCards: 0,
  reviewedToday: 0,
  retentionRate: 0,
  streakDays: 0,
  missingAudio: 0
};

const sampleCsv =
  "word,phonetic,definition_zh,definition_en,example,tags,audio_file\nhello,/həˈləʊ/,你好,used as a greeting,Hello there.,basic;greeting,hello.mp3\nworld,/wɜːld/,世界,the earth and all people,The world is wide.,basic,world.mp3";

export function App() {
  const [tab, setTab] = useState<Tab>("review");
  const [words, setWords] = useState<Word[]>([]);
  const [dueCards, setDueCards] = useState<DueCard[]>([]);
  const [stats, setStats] = useState<LearningStats>(emptyStats);
  const [packs, setPacks] = useState<ResourcePack[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("正在连接本地服务");
  const [error, setError] = useState("");

  async function refresh() {
    setError("");
    try {
      const [nextWords, nextDueCards, nextStats, nextPacks] = await Promise.all([
        api.words(search),
        api.dueCards(),
        api.stats(),
        api.resourcePacks()
      ]);
      setWords(nextWords);
      setDueCards(nextDueCards);
      setStats(nextStats);
      setPacks(nextPacks);
      setStatus("本地服务已连接");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "本地服务连接失败");
      setStatus("本地服务未连接");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleSearch(event: React.FormEvent) {
    event.preventDefault();
    await refresh();
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <BookOpen size={24} />
          <div>
            <strong>英语学习系统</strong>
            <span>{status}</span>
          </div>
        </div>
        <nav>
          <TabButton active={tab === "review"} icon={<HeartPulse size={18} />} label="复习台" onClick={() => setTab("review")} />
          <TabButton active={tab === "words"} icon={<Search size={18} />} label="词库" onClick={() => setTab("words")} />
          <TabButton active={tab === "csv"} icon={<FileUp size={18} />} label="导入导出" onClick={() => setTab("csv")} />
          <TabButton active={tab === "resources"} icon={<Database size={18} />} label="资源包" onClick={() => setTab("resources")} />
          <TabButton active={tab === "sync"} icon={<Wifi size={18} />} label="同步诊断" onClick={() => setTab("sync")} />
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="stats-strip">
            <Metric label="总词数" value={stats.totalWords} />
            <Metric label="待复习" value={stats.dueCards} />
            <Metric label="今日复习" value={stats.reviewedToday} />
            <Metric label="保持率" value={`${stats.retentionRate}%`} />
            <Metric label="缺音频" value={stats.missingAudio} />
          </div>
          <button className="icon-button" onClick={refresh} title="刷新">
            <RefreshCw size={18} />
          </button>
        </header>

        {error ? <div className="alert">{error}</div> : null}

        {tab === "review" ? <ReviewView dueCards={dueCards} refresh={refresh} /> : null}
        {tab === "words" ? (
          <WordsView words={words} search={search} setSearch={setSearch} handleSearch={handleSearch} refresh={refresh} />
        ) : null}
        {tab === "csv" ? <CsvView refresh={refresh} /> : null}
        {tab === "resources" ? <ResourcesView packs={packs} refresh={refresh} /> : null}
        {tab === "sync" ? <SyncView /> : null}
      </section>
    </main>
  );
}

function ReviewView({ dueCards, refresh }: { dueCards: DueCard[]; refresh: () => Promise<void> }) {
  const current = dueCards[0];

  async function review(rating: ReviewRating) {
    if (!current) return;
    await api.review(current.card.id, rating);
    await refresh();
  }

  if (!current) {
    return (
      <section className="panel centered">
        <HeartPulse size={42} />
        <h1>今日复习已清空</h1>
        <p>新增单词或导入 CSV 后，会自动生成到期卡片。</p>
      </section>
    );
  }

  return (
    <section className="review-layout">
      <div className="review-card">
        <span className="eyebrow">待复习 {dueCards.length} 张</span>
        <h1>{current.word.word}</h1>
        <p className="phonetic">{current.word.phonetic || "未填写音标"}</p>
        <div className="definition">
          <strong>{current.word.definitionZh || "未填写中文释义"}</strong>
          <span>{current.word.definitionEn || "未填写英文释义"}</span>
        </div>
        <blockquote>{current.word.example || "暂无例句"}</blockquote>
        <div className="tag-row">
          {current.word.tags.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
          {current.word.audioMissing ? <span className="warning-tag">音频缺失</span> : null}
        </div>
      </div>
      <div className="review-actions">
        <button className="danger" onClick={() => review("again")}>Again</button>
        <button onClick={() => review("hard")}>Hard</button>
        <button className="primary" onClick={() => review("good")}>Good</button>
        <button className="success" onClick={() => review("easy")}>Easy</button>
      </div>
    </section>
  );
}

function WordsView({
  words,
  search,
  setSearch,
  handleSearch,
  refresh
}: {
  words: Word[];
  search: string;
  setSearch: (value: string) => void;
  handleSearch: (event: React.FormEvent) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  return (
    <section className="split-layout">
      <WordForm refresh={refresh} />
      <div className="panel">
        <form className="toolbar" onSubmit={handleSearch}>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索单词、释义" />
          <button className="icon-text" type="submit">
            <Search size={16} />
            搜索
          </button>
        </form>
        <div className="word-table">
          {words.map((word) => (
            <article key={word.id} className="word-row">
              <div>
                <strong>{word.word}</strong>
                <span>{word.definitionZh || word.definitionEn || "暂无释义"}</span>
                <small>{word.tags.join(" / ") || "未标记"} {word.audioMissing ? " · 音频缺失" : ""}</small>
              </div>
              <button className="icon-button danger-ghost" onClick={async () => { await api.deleteWord(word.id); await refresh(); }} title="删除">
                <Trash2 size={16} />
              </button>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function WordForm({ refresh }: { refresh: () => Promise<void> }) {
  const [form, setForm] = useState<WordInput>({ word: "", tags: [] });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await api.createWord({
      ...form,
      tags: typeof form.tags === "string" ? String(form.tags).split(/[;,，；]/) : form.tags
    });
    setForm({ word: "", tags: [] });
    await refresh();
  }

  return (
    <form className="panel form-grid" onSubmit={submit}>
      <h2>新增单词</h2>
      <input required value={form.word} onChange={(event) => setForm({ ...form, word: event.target.value })} placeholder="word" />
      <input value={form.phonetic ?? ""} onChange={(event) => setForm({ ...form, phonetic: event.target.value })} placeholder="音标" />
      <input value={form.definitionZh ?? ""} onChange={(event) => setForm({ ...form, definitionZh: event.target.value })} placeholder="中文释义" />
      <input value={form.definitionEn ?? ""} onChange={(event) => setForm({ ...form, definitionEn: event.target.value })} placeholder="英文释义" />
      <textarea value={form.example ?? ""} onChange={(event) => setForm({ ...form, example: event.target.value })} placeholder="例句" />
      <input
        value={Array.isArray(form.tags) ? form.tags.join(";") : form.tags}
        onChange={(event) => setForm({ ...form, tags: event.target.value.split(/[;,，；]/).filter(Boolean) })}
        placeholder="标签，用分号分隔"
      />
      <input value={form.audioFile ?? ""} onChange={(event) => setForm({ ...form, audioFile: event.target.value })} placeholder="音频文件名" />
      <button className="primary" type="submit">保存单词</button>
    </form>
  );
}

function CsvView({ refresh }: { refresh: () => Promise<void> }) {
  const [csv, setCsv] = useState(sampleCsv);
  const [report, setReport] = useState<CsvImportReport | null>(null);
  const [exported, setExported] = useState("");

  async function importCsv() {
    const nextReport = await api.importCsv(csv);
    setReport(nextReport);
    await refresh();
  }

  async function exportCsv() {
    setExported(await api.exportCsv());
  }

  return (
    <section className="split-layout">
      <div className="panel">
        <h2>CSV 导入</h2>
        <textarea className="csv-box" value={csv} onChange={(event) => setCsv(event.target.value)} />
        <button className="icon-text primary" onClick={importCsv}>
          <FileUp size={16} />
          导入 CSV
        </button>
        {report ? (
          <pre className="result-box">{JSON.stringify(report, null, 2)}</pre>
        ) : null}
      </div>
      <div className="panel">
        <h2>CSV 导出</h2>
        <button className="icon-text" onClick={exportCsv}>
          <Download size={16} />
          导出词库
        </button>
        <textarea className="csv-box" readOnly value={exported} placeholder="导出结果会显示在这里" />
      </div>
    </section>
  );
}

function ResourcesView({ packs, refresh }: { packs: ResourcePack[]; refresh: () => Promise<void> }) {
  const [name, setName] = useState("个人离线资源包");

  async function createPack() {
    await api.createResourcePack({
      name,
      version: new Date().toISOString().slice(0, 10),
      sources: ["WordNet", "Wiktionary", "Lingua Libre"],
      licenses: ["记录待核验"],
      wordCount: 0,
      audioCount: 0
    });
    await refresh();
  }

  return (
    <section className="panel">
      <div className="toolbar">
        <input value={name} onChange={(event) => setName(event.target.value)} />
        <button className="icon-text primary" onClick={createPack}>
          <Database size={16} />
          记录资源包
        </button>
      </div>
      <div className="resource-grid">
        {packs.map((pack) => (
          <article key={pack.id} className="resource-item">
            <strong>{pack.name}</strong>
            <span>{pack.version}</span>
            <small>{pack.sources.join(" / ") || "未记录来源"}</small>
            <small>{pack.licenses.join(" / ") || "未记录许可证"}</small>
          </article>
        ))}
      </div>
    </section>
  );
}

function SyncView() {
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [manifest, setManifest] = useState<Record<string, unknown> | null>(null);
  const [pairing, setPairing] = useState<PairingResponse | null>(null);
  const [changes, setChanges] = useState<{ cursor: number; changes: unknown[] } | null>(null);

  async function diagnose() {
    const [nextHealth, nextManifest, nextChanges] = await Promise.all([api.health(), api.manifest(), api.changes()]);
    setHealth(nextHealth);
    setManifest(nextManifest);
    setChanges(nextChanges);
  }

  async function pair() {
    setPairing(await api.pair("Web 诊断设备"));
  }

  const details = useMemo(() => ({ health, manifest, pairing, changes }), [health, manifest, pairing, changes]);

  return (
    <section className="panel">
      <div className="toolbar">
        <button className="icon-text primary" onClick={diagnose}>
          <Server size={16} />
          同步诊断
        </button>
        <button className="icon-text" onClick={pair}>
          <Wifi size={16} />
          生成配对
        </button>
      </div>
      <pre className="result-box">{JSON.stringify(details, null, 2)}</pre>
    </section>
  );
}

function TabButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button className={active ? "nav-button active" : "nav-button"} onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
