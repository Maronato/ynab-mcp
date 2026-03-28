import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const methodologyDir = dirname(fileURLToPath(import.meta.url));

export interface KnowledgeTopic {
  name: string;
  title: string;
  description: string;
  content: string;
}

const topics: ReadonlyArray<{
  name: string;
  title: string;
  description: string;
  file: string;
}> = [
  {
    name: "terminology",
    title: "YNAB Terminology and Core Concepts",
    description:
      "The Four Rules, milliunits, Ready to Assign, on-budget vs off-budget, Age of Money, transaction states, and budget months.",
    file: "terminology.md",
  },
  {
    name: "credit-cards",
    title: "YNAB Credit Card Handling",
    description:
      "How YNAB models credit card spending vs payments, the payment category, returns, pre-YNAB debt, and credit vs cash overspending on cards.",
    file: "credit-cards.md",
  },
  {
    name: "targets",
    title: "YNAB Targets",
    description:
      "Target types (Target Category Balance, Monthly Savings Builder, Needed for Spending), underfunded calculations, and target interactions with budgeting.",
    file: "targets.md",
  },
  {
    name: "overspending",
    title: "YNAB Overspending",
    description:
      "Cash vs credit overspending, month rollover behavior, hidden credit card debt, and how to cover overspending.",
    file: "overspending.md",
  },
  {
    name: "reconciliation",
    title: "YNAB Reconciliation",
    description:
      "Transaction status lifecycle (uncleared/cleared/reconciled), the reconciliation process, frequency recommendations, and API relevance.",
    file: "reconciliation.md",
  },
  {
    name: "api-quirks",
    title: "YNAB API Quirks and Limitations",
    description:
      "Known YNAB API limitations: supported scheduled transaction frequencies, compound frequency handling, date validation on updates.",
    file: "api-quirks.md",
  },
];

function loadTopic(topic: (typeof topics)[number]): KnowledgeTopic {
  const content = readFileSync(join(methodologyDir, topic.file), "utf-8");
  return {
    name: topic.name,
    title: topic.title,
    description: topic.description,
    content,
  };
}

export function getKnowledgeTopics(): KnowledgeTopic[] {
  return topics.map(loadTopic);
}
