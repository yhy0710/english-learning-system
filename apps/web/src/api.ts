import type { CsvImportReport, DueCard, LearningStats, PairingResponse, ResourcePack, ReviewRating, Word, WordInput } from "@els/shared";

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {})
    },
    ...options
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || response.statusText);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/csv")) return (await response.text()) as T;
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  health: () => request<{ ok: boolean; deviceId: string; protocolVersion: number; time: string }>("/health"),
  manifest: () => request<Record<string, unknown>>("/.well-known/elsync"),
  words: (search = "") => request<Word[]>(`/words?search=${encodeURIComponent(search)}`),
  createWord: (input: WordInput) =>
    request<Word>("/words", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  updateWord: (id: string, input: Partial<WordInput>) =>
    request<Word>(`/words/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  deleteWord: (id: string) =>
    request<void>(`/words/${id}`, {
      method: "DELETE"
    }),
  importCsv: (csv: string) =>
    request<CsvImportReport>("/imports/csv", {
      method: "POST",
      body: JSON.stringify({ csv })
    }),
  exportCsv: () => request<string>("/exports/csv"),
  dueCards: () => request<DueCard[]>("/reviews/due"),
  review: (cardId: string, rating: ReviewRating) =>
    request<DueCard>(`/reviews/${cardId}`, {
      method: "POST",
      body: JSON.stringify({ rating })
    }),
  stats: () => request<LearningStats>("/stats"),
  resourcePacks: () => request<ResourcePack[]>("/resource-packs"),
  createResourcePack: (input: Omit<ResourcePack, "id" | "createdAt">) =>
    request<ResourcePack>("/resource-packs", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  pair: (deviceName: string) =>
    request<PairingResponse>("/pair", {
      method: "POST",
      body: JSON.stringify({ deviceName })
    }),
  changes: () => request<{ cursor: number; changes: unknown[] }>("/sync/changes?since=0")
};
