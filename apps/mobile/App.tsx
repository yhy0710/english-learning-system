import { useEffect, useMemo, useState } from "react";
import { SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
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

const db = SQLite.openDatabaseSync("english-learning.db");

export default function App() {
  const [words, setWords] = useState<MobileWord[]>([]);
  const [word, setWord] = useState("");
  const [definitionZh, setDefinitionZh] = useState("");
  const [serverUrl, setServerUrl] = useState("http://127.0.0.1:5174");
  const [syncStatus, setSyncStatus] = useState("未连接电脑端");

  const dueWord = useMemo(() => words.find((item) => new Date(item.dueAt).getTime() <= Date.now()), [words]);

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
      setSyncStatus(json.ok ? `已连接：${json.deviceId}` : "电脑端响应异常");
    } catch (error) {
      setSyncStatus(error instanceof Error ? error.message : "电脑端连接失败");
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>英语学习系统</Text>
          <Text style={styles.subtitle}>Android 离线单词复习</Text>
        </View>

        <View style={styles.metrics}>
          <Metric label="总词数" value={words.length} />
          <Metric label="待复习" value={words.filter((item) => new Date(item.dueAt).getTime() <= Date.now()).length} />
          <Metric label="已复习" value={words.reduce((sum, item) => sum + item.reviewCount, 0)} />
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>新增单词</Text>
          <TextInput style={styles.input} value={word} onChangeText={setWord} placeholder="word" />
          <TextInput style={styles.input} value={definitionZh} onChangeText={setDefinitionZh} placeholder="中文释义" />
          <TouchableOpacity style={styles.primaryButton} onPress={addWord}>
            <Text style={styles.primaryButtonText}>保存</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>今日复习</Text>
          {dueWord ? (
            <>
              <Text style={styles.reviewWord}>{dueWord.word}</Text>
              <Text style={styles.definition}>{dueWord.definitionZh || "未填写释义"}</Text>
              <View style={styles.reviewActions}>
                <ReviewButton label="Again" onPress={() => review("again")} tone="danger" />
                <ReviewButton label="Hard" onPress={() => review("hard")} />
                <ReviewButton label="Good" onPress={() => review("good")} tone="primary" />
                <ReviewButton label="Easy" onPress={() => review("easy")} tone="success" />
              </View>
            </>
          ) : (
            <Text style={styles.empty}>暂无到期卡片</Text>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>电脑端连接</Text>
          <TextInput style={styles.input} value={serverUrl} onChangeText={setServerUrl} autoCapitalize="none" />
          <TouchableOpacity style={styles.secondaryButton} onPress={checkServer}>
            <Text style={styles.secondaryButtonText}>检查连接</Text>
          </TouchableOpacity>
          <Text style={styles.syncStatus}>{syncStatus}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>词库</Text>
          {words.map((item) => (
            <View key={item.id} style={styles.wordRow}>
              <Text style={styles.wordText}>{item.word}</Text>
              <Text style={styles.definition}>{item.definitionZh || "未填写释义"}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
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

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

function ReviewButton({
  label,
  onPress,
  tone
}: {
  label: string;
  onPress: () => void;
  tone?: "primary" | "success" | "danger";
}) {
  const toneStyle =
    tone === "primary" ? styles.primaryReview : tone === "success" ? styles.successReview : tone === "danger" ? styles.dangerReview : styles.neutralReview;
  return (
    <TouchableOpacity style={[styles.reviewButton, toneStyle]} onPress={onPress}>
      <Text style={styles.reviewButtonText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#eef2f3"
  },
  container: {
    padding: 18,
    gap: 14
  },
  header: {
    paddingTop: 12
  },
  title: {
    fontSize: 30,
    fontWeight: "800",
    color: "#172026"
  },
  subtitle: {
    marginTop: 4,
    color: "#607078"
  },
  metrics: {
    flexDirection: "row",
    gap: 10
  },
  metric: {
    flex: 1,
    backgroundColor: "#ffffff",
    borderRadius: 8,
    padding: 12
  },
  metricLabel: {
    color: "#607078",
    fontSize: 12
  },
  metricValue: {
    marginTop: 4,
    fontSize: 24,
    fontWeight: "800",
    color: "#172026"
  },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 8,
    padding: 16,
    gap: 10
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#172026"
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccd7db",
    borderRadius: 8,
    padding: 12,
    backgroundColor: "#fbfcfc"
  },
  primaryButton: {
    minHeight: 44,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1c6b68"
  },
  primaryButtonText: {
    color: "#ffffff",
    fontWeight: "700"
  },
  secondaryButton: {
    minHeight: 44,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#e2e8ea"
  },
  secondaryButtonText: {
    color: "#172026",
    fontWeight: "700"
  },
  reviewWord: {
    fontSize: 44,
    fontWeight: "800",
    color: "#172026"
  },
  definition: {
    color: "#405158"
  },
  reviewActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  reviewButton: {
    minHeight: 44,
    minWidth: 78,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center"
  },
  neutralReview: {
    backgroundColor: "#e2e8ea"
  },
  primaryReview: {
    backgroundColor: "#1c6b68"
  },
  successReview: {
    backgroundColor: "#3f7d3d"
  },
  dangerReview: {
    backgroundColor: "#b94b4b"
  },
  reviewButtonText: {
    color: "#ffffff",
    fontWeight: "700"
  },
  empty: {
    color: "#607078"
  },
  syncStatus: {
    color: "#405158"
  },
  wordRow: {
    borderTopWidth: 1,
    borderTopColor: "#e1e8eb",
    paddingTop: 10
  },
  wordText: {
    fontSize: 18,
    fontWeight: "700",
    color: "#172026"
  }
});
