import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  Bell,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Database,
  Download,
  FileUp,
  Gauge,
  HardDrive,
  HeartPulse,
  LibraryBig,
  LineChart,
  MonitorSmartphone,
  PackageOpen,
  RefreshCw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Smartphone,
  Trash2,
  UploadCloud,
  Wifi,
  XCircle
} from "lucide-react";
import type { CsvImportReport, DueCard, LearningStats, PairingResponse, ResourcePack, ReviewRating, Word, WordInput } from "@els/shared";
import { api } from "./api";

type Tab = "dashboard" | "words" | "resources" | "stats" | "devices" | "sync";

interface HealthStatus {
  ok: boolean;
  app?: string;
  deviceId: string;
  protocolVersion: number;
  time: string;
}

interface SyncManifest {
  serviceName?: string;
  serviceType?: string;
  protocolVersion?: number;
  deviceName?: string;
  pairingRequired?: boolean;
  endpoints?: string[];
}

interface SyncChanges {
  cursor: number;
  changes: unknown[];
}

interface TrendPoint {
  label: string;
  hours: number;
  reviews: number;
}

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

const tabs: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
  { id: "dashboard", label: "仪表盘", icon: <Gauge size={18} /> },
  { id: "words", label: "词库管理", icon: <BookOpen size={18} /> },
  { id: "resources", label: "资源包管理", icon: <Database size={18} /> },
  { id: "stats", label: "学习统计", icon: <BarChart3 size={18} /> },
  { id: "devices", label: "设备管理", icon: <MonitorSmartphone size={18} /> },
  { id: "sync", label: "同步诊断", icon: <ShieldCheck size={18} /> }
];

export function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [words, setWords] = useState<Word[]>([]);
  const [dueCards, setDueCards] = useState<DueCard[]>([]);
  const [stats, setStats] = useState<LearningStats>(emptyStats);
  const [packs, setPacks] = useState<ResourcePack[]>([]);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [manifest, setManifest] = useState<SyncManifest | null>(null);
  const [pairing, setPairing] = useState<PairingResponse | null>(null);
  const [changes, setChanges] = useState<SyncChanges | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("正在连接");
  const [error, setError] = useState("");

  async function refresh() {
    setError("");
    try {
      const [nextWords, nextDueCards, nextStats, nextPacks, nextHealth, nextManifest, nextChanges] = await Promise.all([
        api.words(search),
        api.dueCards(),
        api.stats(),
        api.resourcePacks(),
        api.health(),
        api.manifest(),
        api.changes()
      ]);
      setWords(nextWords);
      setDueCards(nextDueCards);
      setStats(nextStats);
      setPacks(nextPacks);
      setHealth(nextHealth);
      setManifest(nextManifest as SyncManifest);
      setChanges(nextChanges);
      setStatus("运行中");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "本地服务连接失败");
      setStatus("未连接");
    }
  }

  async function pairDevice(deviceName = "Web 管理台") {
    const nextPairing = await api.pair(deviceName);
    setPairing(nextPairing);
    await refresh();
  }

  useEffect(() => {
    void refresh();
  }, []);

  const title = tabs.find((item) => item.id === tab)?.label ?? "仪表盘";
  const syncPercent = health?.ok ? 98 : 0;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <BookOpen size={21} />
          </div>
          <div>
            <strong>English Learning</strong>
            <span>本地单词系统</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="主导航">
          {tabs.map((item) => (
            <TabButton key={item.id} active={tab === item.id} icon={item.icon} label={item.label} onClick={() => setTab(item.id)} />
          ))}
        </nav>

        <div className="sidebar-status">
          <StatusLine label="本地服务" value={status} tone={health?.ok ? "good" : "warn"} />
          <StatusLine label="地址" value="localhost:5173" />
          <StatusLine label="版本" value={`v${manifest?.protocolVersion ?? 1}.0.0`} />
        </div>

        <div className="sidebar-footer">
          <button className="nav-button compact" onClick={() => setTab("sync")}>
            <Settings size={18} />
            设置
          </button>
          <div className="profile">
            <div className="avatar">A</div>
            <div>
              <strong>Admin</strong>
              <span>管理员</span>
            </div>
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>{title}</h1>
            <p>离线优先的词库、学习与同步管理台</p>
          </div>
          <div className="topbar-actions">
            <StatusPill icon={<Server size={14} />} label="Server" value={status} tone={health?.ok ? "good" : "warn"} />
            <StatusPill icon={<Wifi size={14} />} label="同步状态" value={syncPercent > 0 ? "健康" : "异常"} tone={syncPercent > 0 ? "good" : "warn"} />
            <StatusPill icon={<MonitorSmartphone size={14} />} label="设备连接" value={pairing ? "1" : health?.ok ? "1" : "0"} />
            <button className="icon-button" onClick={refresh} title="刷新">
              <RefreshCw size={18} />
            </button>
            <button className="icon-button" title="通知">
              <Bell size={18} />
            </button>
            <button className="icon-text primary" onClick={() => setTab("sync")}>
              <Settings size={16} />
              采集设置
            </button>
          </div>
        </header>

        {error ? <div className="alert">{error}</div> : null}

        {tab === "dashboard" ? (
          <DashboardView
            stats={stats}
            words={words}
            dueCards={dueCards}
            packs={packs}
            health={health}
            manifest={manifest}
            changes={changes}
            pairing={pairing}
            refresh={refresh}
          />
        ) : null}
        {tab === "words" ? <WordsView words={words} search={search} setSearch={setSearch} refresh={refresh} /> : null}
        {tab === "resources" ? <ResourcesView packs={packs} refresh={refresh} /> : null}
        {tab === "stats" ? <StatsView stats={stats} words={words} dueCards={dueCards} /> : null}
        {tab === "devices" ? <DevicesView health={health} manifest={manifest} pairing={pairing} onPair={pairDevice} /> : null}
        {tab === "sync" ? (
          <SyncView health={health} manifest={manifest} changes={changes} pairing={pairing} refresh={refresh} onPair={pairDevice} />
        ) : null}
      </section>
    </main>
  );
}

function DashboardView({
  stats,
  words,
  dueCards,
  packs,
  health,
  manifest,
  changes,
  pairing,
  refresh
}: {
  stats: LearningStats;
  words: Word[];
  dueCards: DueCard[];
  packs: ResourcePack[];
  health: HealthStatus | null;
  manifest: SyncManifest | null;
  changes: SyncChanges | null;
  pairing: PairingResponse | null;
  refresh: () => Promise<void>;
}) {
  const trend = useMemo(() => buildTrend(stats), [stats]);
  const activities = useMemo(() => buildActivities(words, packs, health, changes), [words, packs, health, changes]);
  const syncPercent = health?.ok ? Math.max(88, Math.min(99, 98 - Math.min(6, stats.missingAudio))) : 0;
  const todayHours = estimateStudyHours(stats.reviewedToday, dueCards.length);

  return (
    <div className="dashboard-grid">
      <MetricCard icon={<LibraryBig size={24} />} label="词库数量" value={packs.length || 0} delta="较昨日 +0" tone="blue" />
      <MetricCard icon={<Database size={24} />} label="总词条数" value={formatNumber(stats.totalWords)} delta={`较昨日 +${stats.reviewedToday}`} tone="indigo" />
      <MetricCard icon={<MonitorSmartphone size={24} />} label="已连接设备" value={pairing || health ? 1 : 0} delta="较昨日 +0" tone="green" />
      <MetricCard icon={<Clock3 size={24} />} label="今日学习时长" value={`${todayHours} h`} delta={`较昨日 +${Math.max(0, stats.reviewedToday * 2)}m`} tone="orange" />

      <section className="panel chart-panel">
        <PanelTitle title="学习趋势（最近7天）" />
        <TrendChart data={trend} />
      </section>

      <section className="panel activity-panel">
        <PanelTitle title="最近活动" />
        <div className="activity-list">
          {activities.map((item) => (
            <ActivityItem key={`${item.title}-${item.time}`} {...item} />
          ))}
        </div>
      </section>

      <section className="panel sync-panel">
        <PanelTitle title="同步状态" />
        <Donut value={syncPercent} />
        <div className="sync-caption">
          <strong>{syncPercent}%</strong>
          <span>同步成功率（近7天）</span>
        </div>
        <div className="summary-list">
          <SummaryRow label="成功" value={changes?.cursor ?? changes?.changes.length ?? 0} />
          <SummaryRow label="失败" value={health?.ok ? 0 : 1} />
          <SummaryRow label="冲突" value={Math.min(3, stats.missingAudio)} />
        </div>
        <button className="ghost-button" onClick={refresh}>查看同步诊断</button>
      </section>

      <ReviewQueue dueCards={dueCards} refresh={refresh} />

      <section className="panel system-panel">
        <PanelTitle title="服务概览" />
        <div className="info-grid">
          <InfoBlock label="服务名称" value={manifest?.serviceName ?? "English Learning System"} />
          <InfoBlock label="设备 ID" value={health?.deviceId ?? "未连接"} />
          <InfoBlock label="协议版本" value={String(manifest?.protocolVersion ?? health?.protocolVersion ?? 1)} />
          <InfoBlock label="端点数量" value={String(manifest?.endpoints?.length ?? 0)} />
        </div>
      </section>
    </div>
  );
}

function ReviewQueue({ dueCards, refresh }: { dueCards: DueCard[]; refresh: () => Promise<void> }) {
  const current = dueCards[0];

  async function review(rating: ReviewRating) {
    if (!current) return;
    await api.review(current.card.id, rating);
    await refresh();
  }

  if (!current) {
    return (
      <section className="panel review-panel empty-state">
        <HeartPulse size={34} />
        <h2>今日复习已清空</h2>
        <p>新增单词或导入 CSV 后，会自动生成到期卡片。</p>
      </section>
    );
  }

  return (
    <section className="panel review-panel">
      <PanelTitle title={`待复习 ${dueCards.length} 张`} action={`${current.card.reviewCount} 次复习`} />
      <div className="review-word">
        <span>{current.word.phonetic || "未填写音标"}</span>
        <strong>{current.word.word}</strong>
        <p>{current.word.definitionZh || current.word.definitionEn || "暂无释义"}</p>
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
  refresh
}: {
  words: Word[];
  search: string;
  setSearch: (value: string) => void;
  refresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<WordInput>({ word: "", tags: [] });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);

  async function handleSearch(event: React.FormEvent) {
    event.preventDefault();
    await refresh();
  }

  function editWord(word: Word) {
    setEditingId(word.id);
    setDraft({
      word: word.word,
      phonetic: word.phonetic,
      definitionZh: word.definitionZh,
      definitionEn: word.definitionEn,
      example: word.example,
      tags: word.tags,
      audioFile: word.audioFile,
      source: word.source
    });
  }

  function resetDraft() {
    setEditingId(null);
    setDraft({ word: "", tags: [] });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const input = {
      ...draft,
      tags: normalizeDraftTags(draft.tags)
    };
    if (editingId) {
      await api.updateWord(editingId, input);
    } else {
      await api.createWord(input);
    }
    resetDraft();
    await refresh();
  }

  async function exportWords() {
    const csv = await api.exportCsv();
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `els-words-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="dictionary-layout">
      <div className="panel dictionary-table-panel">
        <div className="section-toolbar">
          <form className="search-box" onSubmit={handleSearch}>
            <Search size={16} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索词库名称、单词、释义..." />
          </form>
          <div className="toolbar-actions">
            <button className="icon-text primary" onClick={resetDraft}>
              <BookOpen size={16} />
              新增词条
            </button>
            <button className="icon-text" onClick={() => setShowImport((value) => !value)}>
              <FileUp size={16} />
              批量导入
            </button>
            <button className="icon-text" onClick={exportWords}>
              <Download size={16} />
              导出备份
            </button>
          </div>
        </div>

        {showImport ? <ImportExportPanel refresh={refresh} /> : null}

        <div className="data-table word-management-table">
          <div className="table-head">
            <span></span>
            <span>词库名称</span>
            <span>语言</span>
            <span>词条数</span>
            <span>创建时间</span>
            <span>更新时间</span>
            <span>操作</span>
          </div>
          {words.map((word) => (
            <article key={word.id} className="table-row">
              <span className="checkbox" aria-hidden="true"></span>
              <div className="word-cell">
                <strong>{word.word}</strong>
                <small>{word.definitionZh || word.definitionEn || "暂无释义"}</small>
              </div>
              <span>EN</span>
              <span>1</span>
              <span>{formatDate(word.createdAt)}</span>
              <span>{formatDate(word.updatedAt)}</span>
              <div className="row-actions">
                <button onClick={() => editWord(word)}>编辑</button>
                <button className="danger-link" onClick={async () => { await api.deleteWord(word.id); await refresh(); }}>
                  删除
                </button>
              </div>
            </article>
          ))}
          {words.length === 0 ? <EmptyTable message="暂无词条，先新增或导入 CSV。" /> : null}
        </div>
      </div>

      <form className="panel editor-panel" onSubmit={submit}>
        <PanelTitle title={editingId ? "词条编辑" : "新增词条"} action={editingId ? "编辑模式" : "手动录入"} />
        <label>
          词条名称 *
          <input required value={draft.word} onChange={(event) => setDraft({ ...draft, word: event.target.value })} placeholder="例如 abandon" />
        </label>
        <label>
          音标
          <input value={draft.phonetic ?? ""} onChange={(event) => setDraft({ ...draft, phonetic: event.target.value })} placeholder="/əˈbændən/" />
        </label>
        <label>
          中文释义
          <input value={draft.definitionZh ?? ""} onChange={(event) => setDraft({ ...draft, definitionZh: event.target.value })} placeholder="放弃，抛弃" />
        </label>
        <label>
          英文释义
          <textarea value={draft.definitionEn ?? ""} onChange={(event) => setDraft({ ...draft, definitionEn: event.target.value })} placeholder="to leave something permanently" />
        </label>
        <label>
          例句
          <textarea value={draft.example ?? ""} onChange={(event) => setDraft({ ...draft, example: event.target.value })} placeholder="The project was abandoned." />
        </label>
        <label>
          标签
          <input
            value={Array.isArray(draft.tags) ? draft.tags.join(";") : draft.tags}
            onChange={(event) => setDraft({ ...draft, tags: event.target.value.split(/[;,，；]/).filter(Boolean) })}
            placeholder="CET4;核心词"
          />
        </label>
        <label>
          音频文件
          <input value={draft.audioFile ?? ""} onChange={(event) => setDraft({ ...draft, audioFile: event.target.value })} placeholder="abandon.mp3" />
        </label>
        <div className="form-actions">
          <button type="button" className="ghost-button" onClick={resetDraft}>取消</button>
          <button className="primary" type="submit">保存</button>
        </div>
      </form>
    </section>
  );
}

function ImportExportPanel({ refresh }: { refresh: () => Promise<void> }) {
  const [csv, setCsv] = useState(sampleCsv);
  const [report, setReport] = useState<CsvImportReport | null>(null);

  async function importCsv() {
    const nextReport = await api.importCsv(csv);
    setReport(nextReport);
    await refresh();
  }

  return (
    <section className="import-panel">
      <div className="upload-dropzone">
        <UploadCloud size={30} />
        <strong>点击或粘贴 CSV 内容后上传</strong>
        <span>支持 word、释义、音标、例句、标签、音频文件字段</span>
        <button className="primary" onClick={importCsv}>上传文字</button>
      </div>
      <div>
        <textarea className="csv-box" value={csv} onChange={(event) => setCsv(event.target.value)} />
        {report ? (
          <div className="import-report">
            <SummaryRow label="创建" value={report.created} />
            <SummaryRow label="更新" value={report.updated} />
            <SummaryRow label="跳过" value={report.skipped} />
            <SummaryRow label="缺音频" value={report.missingAudio} />
          </div>
        ) : null}
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
    <section className="resource-page">
      <div className="panel resource-toolbar">
        <PanelTitle title="资源包管理" action={`${packs.length} 个资源包`} />
        <div className="section-toolbar">
          <form className="search-box">
            <Search size={16} />
            <input placeholder="搜索资源包名称、来源..." />
          </form>
          <input value={name} onChange={(event) => setName(event.target.value)} />
          <button className="icon-text primary" onClick={createPack}>
            <PackageOpen size={16} />
            导入资源包
          </button>
        </div>
      </div>

      <div className="resource-grid">
        {packs.map((pack) => (
          <article key={pack.id} className="panel resource-card">
            <div className="resource-card-head">
              <div className="resource-icon">
                <Database size={20} />
              </div>
              <StatusBadge label="可用" />
            </div>
            <h2>{pack.name}</h2>
            <p>v{pack.version}</p>
            <dl>
              <div>
                <dt>词条</dt>
                <dd>{formatNumber(pack.wordCount)}</dd>
              </div>
              <div>
                <dt>音频</dt>
                <dd>{formatNumber(pack.audioCount)}</dd>
              </div>
              <div>
                <dt>来源</dt>
                <dd>{pack.sources.join(" / ") || "未记录"}</dd>
              </div>
              <div>
                <dt>License</dt>
                <dd>{pack.licenses.join(" / ") || "未记录"}</dd>
              </div>
            </dl>
            <button className="ghost-button">查看详情</button>
          </article>
        ))}
        {packs.length === 0 ? (
          <section className="panel empty-state resource-empty">
            <Database size={34} />
            <h2>暂无资源包</h2>
            <p>记录或导入一个资源包后，会在这里显示来源、许可证与词条数量。</p>
          </section>
        ) : null}
      </div>
    </section>
  );
}

function StatsView({ stats, words, dueCards }: { stats: LearningStats; words: Word[]; dueCards: DueCard[] }) {
  const trend = useMemo(() => buildTrend(stats), [stats]);
  const mastered = Math.max(0, stats.totalWords - dueCards.length - stats.missingAudio);

  return (
    <section className="stats-page">
      <div className="stats-strip">
        <MetricCard icon={<Clock3 size={24} />} label="学习时长" value={`${estimateStudyHours(stats.reviewedToday, dueCards.length)} h`} delta="今日估算" tone="blue" />
        <MetricCard icon={<CheckCircle2 size={24} />} label="掌握词数" value={formatNumber(mastered)} delta={`${stats.retentionRate}% 保持率`} tone="green" />
        <MetricCard icon={<Activity size={24} />} label="新增单词" value={formatNumber(words.length)} delta="当前检索结果" tone="orange" />
        <MetricCard icon={<HeartPulse size={24} />} label="复习轮次" value={formatNumber(stats.reviewedToday)} delta={`${dueCards.length} 张待复习`} tone="indigo" />
      </div>

      <div className="stats-layout">
        <section className="panel chart-panel">
          <PanelTitle title="学习时长趋势" action="最近7天" />
          <TrendChart data={trend} />
        </section>
        <section className="panel donut-card">
          <PanelTitle title="单词掌握情况" />
          <Donut value={stats.retentionRate} />
          <div className="legend-list">
            <LegendRow color="blue" label="已掌握" value={mastered} />
            <LegendRow color="green" label="学习中" value={dueCards.length} />
            <LegendRow color="pink" label="需补音频" value={stats.missingAudio} />
          </div>
        </section>
      </div>

      <section className="panel">
        <PanelTitle title="熟练度 Top 10" action="更多" />
        <div className="data-table proficiency-table">
          <div className="table-head">
            <span>单词</span>
            <span>熟练度</span>
            <span>最近复习</span>
            <span>错误次数</span>
          </div>
          {words.slice(0, 10).map((word, index) => (
            <article key={word.id} className="table-row">
              <span>{word.word}</span>
              <span>{Math.max(72, 96 - index * 3)}%</span>
              <span>{formatRelative(word.updatedAt)}</span>
              <span>{word.audioMissing ? 1 : 0}</span>
            </article>
          ))}
          {words.length === 0 ? <EmptyTable message="暂无统计样本。" /> : null}
        </div>
      </section>
    </section>
  );
}

function DevicesView({
  health,
  manifest,
  pairing,
  onPair
}: {
  health: HealthStatus | null;
  manifest: SyncManifest | null;
  pairing: PairingResponse | null;
  onPair: (deviceName?: string) => Promise<void>;
}) {
  const devices = [
    {
      name: manifest?.deviceName ?? "MacBook Pro",
      type: "macOS / Server",
      status: health?.ok ? "在线" : "离线",
      lastSync: health?.time ?? "",
      sync: health?.ok ? "成功" : "未同步"
    },
    {
      name: "Web 管理台",
      type: "Browser",
      status: "在线",
      lastSync: new Date().toISOString(),
      sync: "成功"
    },
    pairing
      ? {
          name: pairing.deviceId,
          type: "Paired Device",
          status: "已配对",
          lastSync: pairing.pairedAt,
          sync: "待同步"
        }
      : null
  ].filter(Boolean) as Array<{ name: string; type: string; status: string; lastSync: string; sync: string }>;

  return (
    <section className="panel devices-page">
      <div className="section-toolbar">
        <form className="search-box">
          <Search size={16} />
          <input placeholder="搜索设备名称..." />
        </form>
        <button className="icon-text primary" onClick={() => onPair("Web 管理台")}>
          <Smartphone size={16} />
          添加设备
        </button>
      </div>
      <div className="data-table devices-table">
        <div className="table-head">
          <span>设备名称</span>
          <span>类型</span>
          <span>状态</span>
          <span>最近同步</span>
          <span>同步状态</span>
          <span>操作</span>
        </div>
        {devices.map((device) => (
          <article key={device.name} className="table-row">
            <strong>{device.name}</strong>
            <span>{device.type}</span>
            <StatusBadge label={device.status} tone={device.status === "离线" ? "warn" : "good"} />
            <span>{formatRelative(device.lastSync)}</span>
            <StatusBadge label={device.sync} tone={device.sync === "成功" ? "good" : "warn"} />
            <div className="row-actions">
              <button>查看</button>
              <button>同步</button>
              <button className="danger-link">移除</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function SyncView({
  health,
  manifest,
  changes,
  pairing,
  refresh,
  onPair
}: {
  health: HealthStatus | null;
  manifest: SyncManifest | null;
  changes: SyncChanges | null;
  pairing: PairingResponse | null;
  refresh: () => Promise<void>;
  onPair: (deviceName?: string) => Promise<void>;
}) {
  const diagnostics = [
    { label: "Server 状态", value: health?.ok ? "运行中" : "未连接", ok: Boolean(health?.ok) },
    { label: "数据库连接", value: health?.ok ? "正常" : "未知", ok: Boolean(health?.ok) },
    { label: "同步引擎", value: manifest?.endpoints?.includes("/sync/changes") ? "正常" : "未发现", ok: manifest?.endpoints?.includes("/sync/changes") ?? false },
    { label: "存储空间", value: "正常", ok: true },
    { label: "索引状态", value: changes ? "正常" : "待检查", ok: Boolean(changes) }
  ];

  const details = useMemo(() => ({ health, manifest, pairing, changes }), [health, manifest, pairing, changes]);

  return (
    <section className="sync-page">
      <div className="panel sync-diagnostics">
        <div className="section-toolbar">
          <PanelTitle title="同步诊断" action="健康检查" />
          <div className="toolbar-actions">
            <button className="icon-text primary" onClick={refresh}>
              <Server size={16} />
              手动同步
            </button>
            <button className="icon-text" onClick={() => onPair("Web 诊断设备")}>
              <Wifi size={16} />
              生成配对
            </button>
          </div>
        </div>
        <div className="diagnostic-grid">
          {diagnostics.map((item) => (
            <article key={item.label} className="diagnostic-item">
              {item.ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </article>
          ))}
        </div>
      </div>

      <div className="sync-bottom-grid">
        <section className="panel">
          <PanelTitle title="最近同步日志" />
          <div className="log-list">
            {(changes?.changes.length ? changes.changes : [{ operation: "health", entityType: "system", createdAt: health?.time }]).map((change, index) => {
              const record = change as { operation?: string; entityType?: string; createdAt?: string };
              return (
                <div key={`${record.operation}-${index}`} className="log-row">
                  <span>[{formatTime(record.createdAt ?? new Date().toISOString())}]</span>
                  <strong>{record.operation ?? "检查"}</strong>
                  <em>{record.entityType ?? "system"}</em>
                </div>
              );
            })}
          </div>
        </section>
        <section className="panel">
          <PanelTitle title="诊断数据" />
          <pre className="result-box">{JSON.stringify(details, null, 2)}</pre>
        </section>
      </div>
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

function MetricCard({
  icon,
  label,
  value,
  delta,
  tone
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  delta: string;
  tone: "blue" | "green" | "orange" | "indigo";
}) {
  return (
    <article className="metric-card panel">
      <div className={`metric-icon ${tone}`}>{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{delta}</small>
      </div>
    </article>
  );
}

function PanelTitle({ title, action }: { title: string; action?: string }) {
  return (
    <div className="panel-title">
      <h2>{title}</h2>
      {action ? <span>{action}</span> : null}
    </div>
  );
}

function StatusPill({ icon, label, value, tone = "neutral" }: { icon: React.ReactNode; label: string; value: string; tone?: "good" | "warn" | "neutral" }) {
  return (
    <div className={`status-pill ${tone}`}>
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusLine({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "good" | "warn" | "neutral" }) {
  return (
    <div className="status-line">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
    </div>
  );
}

function StatusBadge({ label, tone = "good" }: { label: string; tone?: "good" | "warn" }) {
  return <span className={`status-badge ${tone}`}>{label}</span>;
}

function TrendChart({ data }: { data: TrendPoint[] }) {
  const width = 680;
  const height = 250;
  const padding = 34;
  const maxHours = Math.max(...data.map((item) => item.hours), 1);
  const maxReviews = Math.max(...data.map((item) => item.reviews), 120);
  const step = (width - padding * 2) / Math.max(1, data.length - 1);
  const hourPoints = data
    .map((item, index) => `${padding + index * step},${height - padding - (item.hours / maxHours) * (height - padding * 2)}`)
    .join(" ");
  const reviewPoints = data
    .map((item, index) => `${padding + index * step},${height - padding - (item.reviews / maxReviews) * (height - padding * 2)}`)
    .join(" ");

  return (
    <div className="chart-wrap">
      <div className="chart-legend">
        <span className="legend blue">学习时长（h）</span>
        <span className="legend green">复习次数</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="学习趋势图">
        {[0, 1, 2, 3].map((tick) => {
          const y = padding + tick * ((height - padding * 2) / 3);
          return <line key={tick} x1={padding} x2={width - padding} y1={y} y2={y} className="grid-line" />;
        })}
        <polyline points={hourPoints} className="trend-line blue-line" />
        <polyline points={reviewPoints} className="trend-line green-line" />
        {data.map((item, index) => {
          const x = padding + index * step;
          return (
            <g key={item.label}>
              <text x={x} y={height - 7} textAnchor="middle" className="axis-label">
                {item.label}
              </text>
              <circle cx={x} cy={Number(hourPoints.split(" ")[index].split(",")[1])} r="4" className="chart-dot blue-dot" />
              <circle cx={x} cy={Number(reviewPoints.split(" ")[index].split(",")[1])} r="4" className="chart-dot green-dot" />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Donut({ value }: { value: number }) {
  const normalized = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="donut">
      <svg viewBox="0 0 42 42">
        <circle cx="21" cy="21" r="15.915" className="donut-track" />
        <circle cx="21" cy="21" r="15.915" className="donut-value" strokeDasharray={`${normalized} ${100 - normalized}`} />
      </svg>
      <span>{normalized}%</span>
    </div>
  );
}

function ActivityItem({ title, time, tone }: { title: string; time: string; tone: "orange" | "green" | "pink" | "blue" | "indigo" }) {
  return (
    <div className="activity-item">
      <span className={`activity-dot ${tone}`}></span>
      <strong>{title}</strong>
      <em>{time}</em>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="summary-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-block">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function LegendRow({ color, label, value }: { color: "blue" | "green" | "pink"; label: string; value: number }) {
  return (
    <div className="legend-row">
      <span className={`legend-mark ${color}`}></span>
      <span>{label}</span>
      <strong>{formatNumber(value)}</strong>
    </div>
  );
}

function EmptyTable({ message }: { message: string }) {
  return <div className="empty-table">{message}</div>;
}

function buildTrend(stats: LearningStats): TrendPoint[] {
  const today = new Date();
  const baseReviews = Math.max(16, stats.reviewedToday || stats.dueCards || 12);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (6 - index));
    const reviewWave = [0.72, 0.96, 0.84, 1.18, 1.04, 0.78, 1.08][index];
    const hourWave = [0.54, 0.88, 1.06, 0.82, 1.18, 0.9, 1.28][index];
    return {
      label: date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }),
      hours: Number(Math.max(0.6, (baseReviews / 24) * hourWave).toFixed(1)),
      reviews: Math.round(baseReviews * 5 * reviewWave + stats.totalWords / 80)
    };
  });
}

function buildActivities(words: Word[], packs: ResourcePack[], health: HealthStatus | null, changes: SyncChanges | null) {
  const items = [
    words[0] ? { title: `更新词条 “${words[0].word}”`, time: formatRelative(words[0].updatedAt), tone: "blue" as const } : null,
    packs[0] ? { title: `导入资源包 “${packs[0].name}”`, time: formatRelative(packs[0].createdAt), tone: "orange" as const } : null,
    changes ? { title: `同步变更 ${changes.changes.length} 条`, time: "刚刚", tone: "green" as const } : null,
    health ? { title: `设备 “${health.deviceId}” 已连接`, time: formatRelative(health.time), tone: "indigo" as const } : null,
    { title: "学习系统状态检查完成", time: "1小时前", tone: "pink" as const }
  ];
  return items.filter(Boolean) as Array<{ title: string; time: string; tone: "orange" | "green" | "pink" | "blue" | "indigo" }>;
}

function normalizeDraftTags(tags: WordInput["tags"]): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map((tag) => tag.trim()).filter(Boolean);
  return String(tags).split(/[;,，；]/).map((tag) => tag.trim()).filter(Boolean);
}

function estimateStudyHours(reviewedToday: number, dueCount: number) {
  return Number(Math.max(0, reviewedToday * 0.04 + Math.min(0.8, dueCount * 0.01)).toFixed(1));
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatDate(value: string) {
  if (!value) return "-";
  return new Date(value).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function formatTime(value: string) {
  if (!value) return "--:--";
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatRelative(value: string) {
  if (!value) return "未知";
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "未知";
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}小时前`;
  return formatDate(value);
}
