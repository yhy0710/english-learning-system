import { useEffect, useMemo, useState } from "react";
import { SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, type DimensionValue } from "react-native";
import * as SQLite from "expo-sqlite";
import { applyReview, createInitialSchedule, type ReviewRating } from "@els/shared";

interface MobileWord {
  id: string;
  word: string;
  definitionZh: string;
  phonetic: string;
  dueAt: string;
  easeFactor: number;
  intervalDays: number;
  lapseCount: number;
  reviewCount: number;
}

type ActiveTab = "home" | "review" | "library" | "stats" | "profile";

const db = SQLite.openDatabaseSync("english-learning.db");

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("home");
  const [words, setWords] = useState<MobileWord[]>([]);
  const [word, setWord] = useState("");
  const [definitionZh, setDefinitionZh] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [showAddWord, setShowAddWord] = useState(false);
  const [serverUrl, setServerUrl] = useState("http://127.0.0.1:5174");
  const [syncStatus, setSyncStatus] = useState("未连接电脑端");

  const dueWords = useMemo(
    () => words.filter((item) => new Date(item.dueAt).getTime() <= Date.now()),
    [words]
  );
  const dueWord = dueWords[0];
  const reviewedTotal = useMemo(() => words.reduce((sum, item) => sum + item.reviewCount, 0), [words]);
  const lapseTotal = useMemo(() => words.reduce((sum, item) => sum + item.lapseCount, 0), [words]);
  const learnedCount = useMemo(() => words.filter((item) => item.reviewCount > 0).length, [words]);
  const accuracy = reviewedTotal ? Math.max(0, Math.round(((reviewedTotal - lapseTotal) / reviewedTotal) * 100)) : 0;
  const filteredWords = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return words;
    return words.filter((item) => {
      const haystack = `${item.word} ${item.definitionZh} ${item.phonetic}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [searchTerm, words]);

  useEffect(() => {
    ensureSchema();
    loadWords();
  }, []);

  function loadWords() {
    const rows = db.getAllSync<MobileWord>(
      `
      SELECT
        id,
        word,
        definition_zh AS definitionZh,
        phonetic,
        due_at AS dueAt,
        ease_factor AS easeFactor,
        interval_days AS intervalDays,
        lapse_count AS lapseCount,
        review_count AS reviewCount
      FROM mobile_words
      ORDER BY updated_at DESC
    `
    );
    setWords(rows);
  }

  function addWord() {
    if (!word.trim()) return;
    const now = new Date();
    const schedule = createInitialSchedule(now);
    db.runSync(
      `
      INSERT INTO mobile_words (
        id, word, definition_zh, phonetic, due_at, ease_factor, interval_days,
        lapse_count, review_count, created_at, updated_at
      )
      VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        cryptoRandomId(),
        word.trim(),
        definitionZh.trim(),
        schedule.dueAt,
        schedule.easeFactor,
        schedule.intervalDays,
        schedule.lapseCount,
        schedule.reviewCount,
        now.toISOString(),
        now.toISOString()
      ]
    );
    setWord("");
    setDefinitionZh("");
    setShowAddWord(false);
    setActiveTab("library");
    loadWords();
  }

  function review(rating: ReviewRating) {
    if (!dueWord) return;
    const next = applyReview(
      {
        easeFactor: dueWord.easeFactor,
        intervalDays: dueWord.intervalDays,
        lapseCount: dueWord.lapseCount,
        reviewCount: dueWord.reviewCount
      },
      rating
    );
    db.runSync(
      `
      UPDATE mobile_words
      SET due_at = ?, ease_factor = ?, interval_days = ?, lapse_count = ?, review_count = ?, updated_at = ?
      WHERE id = ?
    `,
      [next.dueAt, next.easeFactor, next.intervalDays, next.lapseCount, next.reviewCount, new Date().toISOString(), dueWord.id]
    );
    db.runSync(
      "INSERT INTO mobile_review_logs (id, word_id, rating, reviewed_at) VALUES (?, ?, ?, ?)",
      [cryptoRandomId(), dueWord.id, rating, new Date().toISOString()]
    );
    loadWords();
  }

  async function checkServer() {
    try {
      const response = await fetch(`${serverUrl.replace(/\/$/, "")}/health`);
      const json = await response.json();
      setSyncStatus(json.ok ? `已同步：${json.deviceId}` : "电脑端响应异常");
    } catch (error) {
      setSyncStatus(error instanceof Error ? error.message : "电脑端连接失败");
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.appShell}>
        {activeTab === "home" ? (
          <HomeScreen
            words={words}
            dueWords={dueWords}
            reviewedTotal={reviewedTotal}
            learnedCount={learnedCount}
            accuracy={accuracy}
            syncStatus={syncStatus}
            onStartReview={() => setActiveTab("review")}
            onOpenLibrary={() => setActiveTab("library")}
          />
        ) : null}

        {activeTab === "review" ? <ReviewScreen dueWord={dueWord} dueCount={dueWords.length} onReview={review} /> : null}

        {activeTab === "library" ? (
          <LibraryScreen
            words={filteredWords}
            totalWords={words.length}
            searchTerm={searchTerm}
            onSearchTermChange={setSearchTerm}
            word={word}
            definitionZh={definitionZh}
            onWordChange={setWord}
            onDefinitionChange={setDefinitionZh}
            showAddWord={showAddWord}
            onToggleAddWord={() => setShowAddWord((value) => !value)}
            onAddWord={addWord}
          />
        ) : null}

        {activeTab === "stats" ? (
          <StatsScreen words={words} dueCount={dueWords.length} reviewedTotal={reviewedTotal} learnedCount={learnedCount} accuracy={accuracy} />
        ) : null}

        {activeTab === "profile" ? (
          <ProfileScreen
            words={words}
            syncStatus={syncStatus}
            serverUrl={serverUrl}
            onServerUrlChange={setServerUrl}
            onCheckServer={checkServer}
          />
        ) : null}

        <BottomNav activeTab={activeTab} onChange={setActiveTab} />
      </View>
    </SafeAreaView>
  );
}

function HomeScreen({
  words,
  dueWords,
  reviewedTotal,
  learnedCount,
  accuracy,
  syncStatus,
  onStartReview,
  onOpenLibrary
}: {
  words: MobileWord[];
  dueWords: MobileWord[];
  reviewedTotal: number;
  learnedCount: number;
  accuracy: number;
  syncStatus: string;
  onStartReview: () => void;
  onOpenLibrary: () => void;
}) {
  const recentWords = words.slice(0, 5);

  return (
    <ScreenScroll>
      <View style={styles.heroHeader}>
        <View>
          <Text style={styles.greeting}>Good morning!</Text>
          <Text style={styles.subtleText}>今天也是努力学习的一天</Text>
        </View>
        <StatusPill label={syncStatus.startsWith("已同步") ? "已同步" : "离线"} tone={syncStatus.startsWith("已同步") ? "success" : "neutral"} />
      </View>

      <View style={[styles.panel, styles.syncPanel]}>
        <View>
          <Text style={styles.panelKicker}>同步状态</Text>
          <Text style={styles.syncText}>{syncStatus}</Text>
        </View>
        <View style={styles.cloudBadge}>
          <Text style={styles.cloudBadgeText}>✓</Text>
        </View>
      </View>

      <View style={styles.panel}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>今日学习</Text>
          <TouchableOpacity onPress={onOpenLibrary}>
            <Text style={styles.linkText}>词库</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.metricsGrid}>
          <Metric label="待复习" value={dueWords.length} />
          <Metric label="已完成" value={reviewedTotal} />
          <Metric label="正确率" value={accuracy ? `${accuracy}%` : "--"} />
        </View>
        <TouchableOpacity style={styles.primaryButton} onPress={onStartReview}>
          <Text style={styles.primaryButtonText}>开始复习</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.panel}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>今日到期单词</Text>
          <Text style={styles.mutedSmall}>共 {dueWords.length} 个</Text>
        </View>
        {recentWords.length ? (
          recentWords.map((item) => <CompactWordRow key={item.id} word={item} />)
        ) : (
          <EmptyState title="还没有单词" body="去词库新增一个单词后，就可以开始复习。" />
        )}
      </View>

      <View style={styles.panel}>
        <Text style={styles.sectionTitle}>连续学习</Text>
        <View style={styles.streakRow}>
          <Text style={styles.streakCount}>{Math.min(12, Math.max(0, learnedCount))}</Text>
          <Text style={styles.streakLabel}>天</Text>
        </View>
        <View style={styles.dotsRow}>
          {[18, 32, 24, 42, 28, 46, 36].map((size, index) => (
            <View key={index} style={[styles.progressDot, { width: size, opacity: 0.45 + index * 0.06 }]} />
          ))}
        </View>
      </View>
    </ScreenScroll>
  );
}

function ReviewScreen({
  dueWord,
  dueCount,
  onReview
}: {
  dueWord: MobileWord | undefined;
  dueCount: number;
  onReview: (rating: ReviewRating) => void;
}) {
  const progress: DimensionValue = `${Math.max(8, Math.min(100, 100 - dueCount * 2))}%`;

  return (
    <ScreenScroll>
      <View style={styles.topBar}>
        <Text style={styles.screenTitle}>学习中</Text>
        <Text style={styles.mutedSmall}>{Math.max(0, 48 - dueCount)} / 48</Text>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: progress }]} />
      </View>

      {dueWord ? (
        <>
          <View style={[styles.panel, styles.reviewCard]}>
            <Text style={styles.reviewWord}>{dueWord.word}</Text>
            <Text style={styles.phonetic}>{dueWord.phonetic || "/phonetic/"}</Text>
            <View style={styles.audioButton}>
              <Text style={styles.audioButtonText}>▶</Text>
            </View>
            <View style={styles.definitionBlock}>
              <Text style={styles.wordType}>vt.</Text>
              <Text style={styles.definition}>{dueWord.definitionZh || "未填写中文释义"}</Text>
            </View>
            <View style={styles.divider} />
            <Text style={styles.exampleText}>He decided to keep practicing every day.</Text>
            <Text style={styles.exampleTranslation}>他决定每天坚持练习。</Text>
            <View style={styles.tagRow}>
              <Tag label={`间隔 ${dueWord.intervalDays} 天`} />
              <Tag label={`复习 ${dueWord.reviewCount} 次`} />
              <Tag label={dueWord.lapseCount ? "需巩固" : "稳定"} tone={dueWord.lapseCount ? "warning" : "success"} />
            </View>
          </View>
          <View style={styles.reviewActions}>
            <ReviewButton label="Again" meta="< 1 分钟" onPress={() => onReview("again")} tone="danger" />
            <ReviewButton label="Hard" meta="10 分钟" onPress={() => onReview("hard")} tone="warning" />
            <ReviewButton label="Good" meta="4 天" onPress={() => onReview("good")} tone="primary" />
            <ReviewButton label="Easy" meta="10 天" onPress={() => onReview("easy")} tone="success" />
          </View>
        </>
      ) : (
        <View style={[styles.panel, styles.emptyReviewCard]}>
          <Text style={styles.reviewWordSmall}>今日已完成</Text>
          <Text style={styles.emptyBody}>暂无到期卡片，可以去词库新增单词或稍后再来。</Text>
        </View>
      )}
    </ScreenScroll>
  );
}

function LibraryScreen({
  words,
  totalWords,
  searchTerm,
  onSearchTermChange,
  word,
  definitionZh,
  onWordChange,
  onDefinitionChange,
  showAddWord,
  onToggleAddWord,
  onAddWord
}: {
  words: MobileWord[];
  totalWords: number;
  searchTerm: string;
  onSearchTermChange: (value: string) => void;
  word: string;
  definitionZh: string;
  onWordChange: (value: string) => void;
  onDefinitionChange: (value: string) => void;
  showAddWord: boolean;
  onToggleAddWord: () => void;
  onAddWord: () => void;
}) {
  return (
    <ScreenScroll>
      <View style={styles.topBar}>
        <Text style={styles.screenTitle}>词库</Text>
        <TouchableOpacity style={styles.iconButton} onPress={onToggleAddWord}>
          <Text style={styles.iconButtonText}>{showAddWord ? "×" : "+"}</Text>
        </TouchableOpacity>
      </View>

      <TextInput
        style={styles.searchInput}
        value={searchTerm}
        onChangeText={onSearchTermChange}
        placeholder="搜索单词或释义"
        placeholderTextColor="#9BA8B8"
        autoCapitalize="none"
      />

      <View style={styles.filterRow}>
        <FilterChip label="全部词库" active />
        <FilterChip label="全部标签" />
        <FilterChip label="到期状态" />
      </View>

      {showAddWord ? (
        <View style={styles.panel}>
          <Text style={styles.sectionTitle}>新增单词</Text>
          <TextInput
            style={styles.input}
            value={word}
            onChangeText={onWordChange}
            placeholder="请输入单词"
            placeholderTextColor="#A7B1BF"
            autoCapitalize="none"
          />
          <TextInput
            style={[styles.input, styles.textArea]}
            value={definitionZh}
            onChangeText={onDefinitionChange}
            placeholder="请输入中文释义"
            placeholderTextColor="#A7B1BF"
            multiline
          />
          <TouchableOpacity style={styles.primaryButton} onPress={onAddWord}>
            <Text style={styles.primaryButtonText}>保存</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={styles.listSummary}>
        <Text style={styles.mutedSmall}>共 {totalWords} 个单词</Text>
        <Text style={styles.mutedSmall}>筛选 {words.length}</Text>
      </View>

      {words.length ? (
        words.map((item) => <LibraryWordCard key={item.id} word={item} />)
      ) : (
        <View style={styles.panel}>
          <EmptyState title="没有匹配单词" body="调整搜索条件，或点击右上角新增单词。" />
        </View>
      )}
    </ScreenScroll>
  );
}

function StatsScreen({
  words,
  dueCount,
  reviewedTotal,
  learnedCount,
  accuracy
}: {
  words: MobileWord[];
  dueCount: number;
  reviewedTotal: number;
  learnedCount: number;
  accuracy: number;
}) {
  return (
    <ScreenScroll>
      <View style={styles.topBar}>
        <Text style={styles.screenTitle}>学习统计</Text>
      </View>
      <View style={styles.filterRow}>
        <FilterChip label="今日" active />
        <FilterChip label="本周" />
        <FilterChip label="本月" />
        <FilterChip label="全部" />
      </View>

      <View style={styles.statsGrid}>
        <Metric label="今日复习" value={reviewedTotal} accent="success" />
        <Metric label="正确率" value={accuracy ? `${accuracy}%` : "--"} />
        <Metric label="到期单词" value={dueCount} accent="warning" />
        <Metric label="已学单词" value={learnedCount} />
      </View>

      <View style={styles.panel}>
        <Text style={styles.sectionTitle}>复习数量趋势</Text>
        <View style={styles.chartArea}>
          {[22, 38, 36, 24, 34, 48, 42].map((height, index) => (
            <View key={index} style={styles.chartColumn}>
              <View style={[styles.chartBar, { height }]} />
              <Text style={styles.chartLabel}>{`${index * 4}:00`}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.panel}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>熟练度 Top 10</Text>
          <Text style={styles.linkText}>更多</Text>
        </View>
        {words.slice(0, 5).map((item) => (
          <View key={item.id} style={styles.tableRow}>
            <Text style={styles.tableWord}>{item.word}</Text>
            <Text style={styles.tableValue}>{Math.min(99, 70 + item.reviewCount * 5)}%</Text>
            <Text style={styles.tableMeta}>{item.intervalDays || 1} 天后</Text>
          </View>
        ))}
        {!words.length ? <EmptyState title="暂无统计" body="完成复习后这里会显示趋势和熟练度。" /> : null}
      </View>
    </ScreenScroll>
  );
}

function ProfileScreen({
  words,
  syncStatus,
  serverUrl,
  onServerUrlChange,
  onCheckServer
}: {
  words: MobileWord[];
  syncStatus: string;
  serverUrl: string;
  onServerUrlChange: (value: string) => void;
  onCheckServer: () => void;
}) {
  return (
    <ScreenScroll>
      <Text style={styles.screenTitle}>我的</Text>

      <View style={[styles.panel, styles.profileCard]}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>L</Text>
        </View>
        <View style={styles.profileText}>
          <Text style={styles.profileName}>学习者</Text>
          <Text style={styles.subtleText}>ID: learner_001</Text>
        </View>
        <Text style={styles.chevron}>›</Text>
      </View>

      <View style={styles.panel}>
        <Text style={styles.sectionTitle}>同步状态</Text>
        <View style={styles.syncStateRow}>
          <View style={styles.cloudLarge}>
            <Text style={styles.cloudLargeText}>✓</Text>
          </View>
          <View style={styles.profileText}>
            <Text style={styles.syncText}>{syncStatus}</Text>
            <Text style={styles.subtleText}>本机词库 {words.length} 个单词</Text>
          </View>
        </View>
        <TextInput
          style={styles.input}
          value={serverUrl}
          onChangeText={onServerUrlChange}
          autoCapitalize="none"
          placeholder="电脑端服务地址"
          placeholderTextColor="#A7B1BF"
        />
        <TouchableOpacity style={styles.primaryButton} onPress={onCheckServer}>
          <Text style={styles.primaryButtonText}>立即同步</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.menuPanel}>
        {["设备管理", "同步设置", "导入 / 导出", "词本管理", "标签管理", "数据备份", "关于我们"].map((label) => (
          <View key={label} style={styles.menuRow}>
            <Text style={styles.menuIcon}>□</Text>
            <Text style={styles.menuLabel}>{label}</Text>
            <Text style={styles.chevron}>›</Text>
          </View>
        ))}
      </View>

      <TouchableOpacity style={styles.logoutButton}>
        <Text style={styles.logoutText}>退出登录</Text>
      </TouchableOpacity>
    </ScreenScroll>
  );
}

function ScreenScroll({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.screenContent} showsVerticalScrollIndicator={false}>
      {children}
    </ScrollView>
  );
}

function Metric({
  label,
  value,
  accent = "primary"
}: {
  label: string;
  value: number | string;
  accent?: "primary" | "success" | "warning";
}) {
  const accentStyle = accent === "success" ? styles.metricAccentSuccess : accent === "warning" ? styles.metricAccentWarning : styles.metricAccentPrimary;
  return (
    <View style={styles.metric}>
      <View style={[styles.metricIcon, accentStyle]} />
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

function CompactWordRow({ word }: { word: MobileWord }) {
  return (
    <View style={styles.compactRow}>
      <View style={styles.profileText}>
        <Text style={styles.compactWord}>{word.word}</Text>
        <Text style={styles.compactDefinition} numberOfLines={1}>
          {word.definitionZh || "未填写释义"}
        </Text>
      </View>
      <Tag label={word.lapseCount ? "困难" : word.reviewCount ? "一般" : "容易"} tone={word.lapseCount ? "danger" : word.reviewCount ? "warning" : "success"} />
    </View>
  );
}

function LibraryWordCard({ word }: { word: MobileWord }) {
  const dueText = new Date(word.dueAt).getTime() <= Date.now() ? "今天到期" : `${Math.max(1, word.intervalDays)} 天后到期`;
  return (
    <View style={styles.wordCard}>
      <View style={styles.sectionHeader}>
        <View style={styles.profileText}>
          <Text style={styles.wordText}>{word.word}</Text>
          <Text style={styles.phoneticSmall}>{word.phonetic || "/phonetic/"}</Text>
        </View>
        <Text style={styles.moreText}>•••</Text>
      </View>
      <Text style={styles.cardDefinition} numberOfLines={2}>
        {word.definitionZh || "未填写中文释义"}
      </Text>
      <View style={styles.tagRow}>
        <Tag label="四级" />
        <Tag label={word.reviewCount ? "已复习" : "新词"} tone={word.reviewCount ? "success" : "neutral"} />
        <Text style={styles.dueText}>{dueText}</Text>
      </View>
    </View>
  );
}

function ReviewButton({
  label,
  meta,
  onPress,
  tone
}: {
  label: string;
  meta: string;
  onPress: () => void;
  tone: "primary" | "success" | "danger" | "warning";
}) {
  const toneStyle =
    tone === "primary"
      ? styles.primaryReview
      : tone === "success"
        ? styles.successReview
        : tone === "danger"
          ? styles.dangerReview
          : styles.warningReview;
  return (
    <TouchableOpacity style={[styles.reviewButton, toneStyle]} onPress={onPress}>
      <Text style={styles.reviewButtonText}>{label}</Text>
      <Text style={styles.reviewButtonMeta}>{meta}</Text>
    </TouchableOpacity>
  );
}

function FilterChip({ label, active = false }: { label: string; active?: boolean }) {
  return (
    <View style={[styles.filterChip, active ? styles.filterChipActive : null]}>
      <Text style={[styles.filterChipText, active ? styles.filterChipTextActive : null]}>{label}</Text>
    </View>
  );
}

function StatusPill({ label, tone }: { label: string; tone: "success" | "neutral" }) {
  return (
    <View style={[styles.statusPill, tone === "success" ? styles.statusPillSuccess : styles.statusPillNeutral]}>
      <View style={[styles.statusDot, tone === "success" ? styles.statusDotSuccess : styles.statusDotNeutral]} />
      <Text style={styles.statusPillText}>{label}</Text>
    </View>
  );
}

function Tag({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "success" | "warning" | "danger" }) {
  const toneStyle =
    tone === "success" ? styles.tagSuccess : tone === "warning" ? styles.tagWarning : tone === "danger" ? styles.tagDanger : styles.tagNeutral;
  return (
    <View style={[styles.tag, toneStyle]}>
      <Text style={styles.tagText}>{label}</Text>
    </View>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

function BottomNav({ activeTab, onChange }: { activeTab: ActiveTab; onChange: (tab: ActiveTab) => void }) {
  const tabs: Array<{ key: ActiveTab; label: string; icon: string }> = [
    { key: "home", label: "首页", icon: "⌂" },
    { key: "review", label: "学习", icon: "◉" },
    { key: "library", label: "词库", icon: "▣" },
    { key: "stats", label: "统计", icon: "▥" },
    { key: "profile", label: "我的", icon: "●" }
  ];

  return (
    <View style={styles.bottomNav}>
      {tabs.map((tab) => {
        const active = tab.key === activeTab;
        return (
          <TouchableOpacity key={tab.key} style={styles.navItem} onPress={() => onChange(tab.key)}>
            <Text style={[styles.navIcon, active ? styles.navIconActive : null]}>{tab.icon}</Text>
            <Text style={[styles.navLabel, active ? styles.navLabelActive : null]}>{tab.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function ensureSchema() {
  db.execSync(`
    CREATE TABLE IF NOT EXISTS mobile_words (
      id TEXT PRIMARY KEY,
      word TEXT NOT NULL,
      definition_zh TEXT NOT NULL DEFAULT '',
      phonetic TEXT NOT NULL DEFAULT '',
      due_at TEXT NOT NULL,
      ease_factor REAL NOT NULL DEFAULT 2.5,
      interval_days INTEGER NOT NULL DEFAULT 0,
      lapse_count INTEGER NOT NULL DEFAULT 0,
      review_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mobile_review_logs (
      id TEXT PRIMARY KEY,
      word_id TEXT NOT NULL,
      rating TEXT NOT NULL,
      reviewed_at TEXT NOT NULL
    );
  `);
}

function cryptoRandomId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#F4F6FB"
  },
  appShell: {
    flex: 1,
    backgroundColor: "#F4F6FB"
  },
  screen: {
    flex: 1
  },
  screenContent: {
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 96,
    gap: 14
  },
  heroHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12
  },
  greeting: {
    fontSize: 20,
    fontWeight: "800",
    color: "#111827"
  },
  subtleText: {
    marginTop: 4,
    color: "#7A8699",
    fontSize: 12
  },
  topBar: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12
  },
  screenTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: "#111827"
  },
  panel: {
    backgroundColor: "#FFFFFF",
    borderRadius: 8,
    padding: 16,
    gap: 12,
    shadowColor: "#AEB8C7",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.14,
    shadowRadius: 18,
    elevation: 3
  },
  syncPanel: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  panelKicker: {
    color: "#6B7280",
    fontSize: 12,
    fontWeight: "700"
  },
  syncText: {
    marginTop: 4,
    color: "#1F2937",
    fontSize: 14,
    fontWeight: "700"
  },
  cloudBadge: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: "#E8F8EF",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#BCE7CE"
  },
  cloudBadgeText: {
    color: "#20B36B",
    fontWeight: "900"
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#111827"
  },
  linkText: {
    color: "#2F6DE1",
    fontSize: 12,
    fontWeight: "800"
  },
  mutedSmall: {
    color: "#8B95A6",
    fontSize: 12,
    fontWeight: "600"
  },
  metricsGrid: {
    flexDirection: "row",
    gap: 8
  },
  metric: {
    flex: 1,
    minHeight: 84,
    borderRadius: 8,
    padding: 12,
    backgroundColor: "#F8FAFE",
    borderWidth: 1,
    borderColor: "#EEF2F8"
  },
  metricIcon: {
    width: 22,
    height: 4,
    borderRadius: 8,
    marginBottom: 10
  },
  metricAccentPrimary: {
    backgroundColor: "#2F6DE1"
  },
  metricAccentSuccess: {
    backgroundColor: "#2DBE7F"
  },
  metricAccentWarning: {
    backgroundColor: "#F59E0B"
  },
  metricLabel: {
    color: "#7A8699",
    fontSize: 11,
    fontWeight: "700"
  },
  metricValue: {
    marginTop: 6,
    fontSize: 22,
    fontWeight: "900",
    color: "#111827"
  },
  primaryButton: {
    minHeight: 46,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#2F6DE1"
  },
  primaryButtonText: {
    color: "#FFFFFF",
    fontWeight: "800"
  },
  compactRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: "#EEF2F8",
    paddingTop: 10,
    gap: 12
  },
  profileText: {
    flex: 1
  },
  compactWord: {
    color: "#111827",
    fontSize: 14,
    fontWeight: "800"
  },
  compactDefinition: {
    marginTop: 2,
    color: "#7A8699",
    fontSize: 12
  },
  streakRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 4
  },
  streakCount: {
    color: "#F97316",
    fontSize: 22,
    fontWeight: "900"
  },
  streakLabel: {
    color: "#6B7280",
    fontSize: 13,
    fontWeight: "700",
    paddingBottom: 3
  },
  dotsRow: {
    height: 26,
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  progressDot: {
    height: 6,
    borderRadius: 8,
    backgroundColor: "#2F6DE1"
  },
  progressTrack: {
    height: 4,
    borderRadius: 8,
    backgroundColor: "#E3E8F2",
    overflow: "hidden"
  },
  progressFill: {
    height: 4,
    borderRadius: 8,
    backgroundColor: "#2F6DE1"
  },
  reviewCard: {
    minHeight: 430,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 30
  },
  reviewWord: {
    fontSize: 36,
    fontWeight: "900",
    color: "#111827"
  },
  reviewWordSmall: {
    fontSize: 24,
    fontWeight: "900",
    color: "#111827",
    textAlign: "center"
  },
  phonetic: {
    marginTop: 8,
    color: "#7A8699",
    fontSize: 14
  },
  audioButton: {
    width: 38,
    height: 38,
    marginTop: 18,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#2F6DE1"
  },
  audioButtonText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "900"
  },
  definitionBlock: {
    alignSelf: "stretch",
    marginTop: 34,
    gap: 6
  },
  wordType: {
    color: "#111827",
    fontSize: 13,
    fontWeight: "900"
  },
  definition: {
    color: "#1F2937",
    fontSize: 14,
    lineHeight: 22
  },
  divider: {
    alignSelf: "stretch",
    height: 1,
    marginVertical: 6,
    backgroundColor: "#EEF2F8"
  },
  exampleText: {
    alignSelf: "stretch",
    color: "#111827",
    fontSize: 13,
    lineHeight: 20
  },
  exampleTranslation: {
    alignSelf: "stretch",
    color: "#7A8699",
    fontSize: 12,
    lineHeight: 18
  },
  tagRow: {
    alignSelf: "stretch",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8
  },
  tag: {
    minHeight: 24,
    borderRadius: 6,
    paddingHorizontal: 8,
    alignItems: "center",
    justifyContent: "center"
  },
  tagNeutral: {
    backgroundColor: "#EEF3FF"
  },
  tagSuccess: {
    backgroundColor: "#E6F8EF"
  },
  tagWarning: {
    backgroundColor: "#FFF4DF"
  },
  tagDanger: {
    backgroundColor: "#FFE9E9"
  },
  tagText: {
    color: "#526070",
    fontSize: 11,
    fontWeight: "800"
  },
  reviewActions: {
    flexDirection: "row",
    gap: 8
  },
  reviewButton: {
    flex: 1,
    minHeight: 66,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center"
  },
  primaryReview: {
    backgroundColor: "#2F8CFF"
  },
  successReview: {
    backgroundColor: "#31C76A"
  },
  dangerReview: {
    backgroundColor: "#FF4B4B"
  },
  warningReview: {
    backgroundColor: "#FFAA20"
  },
  reviewButtonText: {
    color: "#FFFFFF",
    fontWeight: "900",
    fontSize: 13
  },
  reviewButtonMeta: {
    marginTop: 3,
    color: "#FFFFFF",
    fontSize: 10,
    fontWeight: "700"
  },
  emptyReviewCard: {
    minHeight: 360,
    justifyContent: "center"
  },
  iconButton: {
    width: 38,
    height: 38,
    borderRadius: 8,
    backgroundColor: "#2F6DE1",
    alignItems: "center",
    justifyContent: "center"
  },
  iconButtonText: {
    color: "#FFFFFF",
    fontSize: 24,
    fontWeight: "700",
    lineHeight: 26
  },
  searchInput: {
    minHeight: 46,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#E5EAF2",
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 14,
    color: "#111827",
    fontSize: 14
  },
  filterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  filterChip: {
    minHeight: 34,
    borderRadius: 8,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#EEF2F8"
  },
  filterChipActive: {
    backgroundColor: "#2F6DE1",
    borderColor: "#2F6DE1"
  },
  filterChipText: {
    color: "#667085",
    fontSize: 12,
    fontWeight: "800"
  },
  filterChipTextActive: {
    color: "#FFFFFF"
  },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: "#E3E8F2",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#FBFCFF",
    color: "#111827"
  },
  textArea: {
    minHeight: 90,
    textAlignVertical: "top"
  },
  listSummary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  wordCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 8,
    padding: 14,
    gap: 10,
    borderWidth: 1,
    borderColor: "#EEF2F8",
    shadowColor: "#AEB8C7",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.1,
    shadowRadius: 14,
    elevation: 2
  },
  wordText: {
    color: "#111827",
    fontSize: 16,
    fontWeight: "900"
  },
  phoneticSmall: {
    color: "#8B95A6",
    fontSize: 12,
    marginTop: 2
  },
  moreText: {
    color: "#A8B1BF",
    fontSize: 16,
    fontWeight: "900"
  },
  cardDefinition: {
    color: "#4B5563",
    fontSize: 13,
    lineHeight: 20
  },
  dueText: {
    marginLeft: "auto",
    color: "#2F6DE1",
    fontSize: 11,
    fontWeight: "800"
  },
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  chartArea: {
    height: 150,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "#E5EAF2",
    paddingTop: 20
  },
  chartColumn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 8
  },
  chartBar: {
    width: 18,
    borderRadius: 6,
    backgroundColor: "#2F6DE1"
  },
  chartLabel: {
    color: "#98A2B3",
    fontSize: 9
  },
  tableRow: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: "#EEF2F8",
    gap: 12
  },
  tableWord: {
    flex: 1,
    color: "#111827",
    fontWeight: "800"
  },
  tableValue: {
    width: 52,
    color: "#20A66A",
    fontWeight: "900",
    textAlign: "right"
  },
  tableMeta: {
    width: 58,
    color: "#7A8699",
    fontSize: 12,
    textAlign: "right"
  },
  profileCard: {
    flexDirection: "row",
    alignItems: "center"
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#E6F0FF",
    alignItems: "center",
    justifyContent: "center"
  },
  avatarText: {
    color: "#2F6DE1",
    fontSize: 20,
    fontWeight: "900"
  },
  profileName: {
    color: "#111827",
    fontSize: 16,
    fontWeight: "900"
  },
  chevron: {
    color: "#A8B1BF",
    fontSize: 26
  },
  syncStateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12
  },
  cloudLarge: {
    width: 54,
    height: 54,
    borderRadius: 8,
    backgroundColor: "#EAF5FF",
    alignItems: "center",
    justifyContent: "center"
  },
  cloudLargeText: {
    color: "#25B86F",
    fontSize: 22,
    fontWeight: "900"
  },
  menuPanel: {
    backgroundColor: "#FFFFFF",
    borderRadius: 8,
    overflow: "hidden",
    shadowColor: "#AEB8C7",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.1,
    shadowRadius: 18,
    elevation: 2
  },
  menuRow: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#F0F3F8",
    gap: 12
  },
  menuIcon: {
    color: "#111827",
    fontSize: 14,
    fontWeight: "900"
  },
  menuLabel: {
    flex: 1,
    color: "#111827",
    fontSize: 14,
    fontWeight: "700"
  },
  logoutButton: {
    minHeight: 46,
    borderRadius: 8,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center"
  },
  logoutText: {
    color: "#FF4B4B",
    fontWeight: "900"
  },
  emptyState: {
    paddingVertical: 12,
    gap: 4
  },
  emptyTitle: {
    color: "#111827",
    fontSize: 14,
    fontWeight: "900"
  },
  emptyBody: {
    color: "#7A8699",
    fontSize: 13,
    lineHeight: 20
  },
  statusPill: {
    minHeight: 30,
    borderRadius: 8,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6
  },
  statusPillSuccess: {
    backgroundColor: "#E8F8EF"
  },
  statusPillNeutral: {
    backgroundColor: "#EEF2F8"
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3
  },
  statusDotSuccess: {
    backgroundColor: "#20B36B"
  },
  statusDotNeutral: {
    backgroundColor: "#8B95A6"
  },
  statusPillText: {
    color: "#526070",
    fontSize: 11,
    fontWeight: "900"
  },
  bottomNav: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    minHeight: 72,
    paddingTop: 8,
    paddingBottom: 10,
    paddingHorizontal: 10,
    flexDirection: "row",
    backgroundColor: "#FFFFFF",
    borderTopWidth: 1,
    borderTopColor: "#E8EDF5"
  },
  navItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 3
  },
  navIcon: {
    color: "#A0ABBB",
    fontSize: 18,
    fontWeight: "900"
  },
  navIconActive: {
    color: "#2F6DE1"
  },
  navLabel: {
    color: "#A0ABBB",
    fontSize: 10,
    fontWeight: "800"
  },
  navLabelActive: {
    color: "#2F6DE1"
  }
});
