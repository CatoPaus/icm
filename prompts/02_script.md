---
model: gemini-4-argon
config:
  maxOutputTokens: 32768
  thinkingConfig:
    thinkingLevel: MEDIUM
    includeThoughts: true
input:
  schema:
    researchFile: string
    toneRules: string
    globalIdentity?: string
    workspaceContext?: string
output:
  format: json
  schema:
    title: string
    scriptBody: string
    estimatedDuration: integer
---
{{#if globalIdentity}}
{{globalIdentity}}

{{/if}}
{{#if workspaceContext}}
{{workspaceContext}}

{{/if}}
You are an expert scriptwriter executing **Stage 2 (Voiceover Scriptwriting)**.

TASK:
Transform the provided research text into a highly engaging, structured script.

STYLE CONSTRAINTS:
Adhere to these tone requirements:
{{toneRules}}

Additionally, follow these structural and spoken-delivery constraints:
- Write the script using short, readable sentences. Aim for approximately 80–120 characters (about 15–25 words) per sentence. This ensures natural breathing pauses and optimal pacing for voiceover delivery.
- The source research is an Open Knowledge Format (`OKF v0.2`) concept document containing YAML frontmatter (`sources`, `generated`, `verified`, `stale_after`) and `[^id]` footnote markers.
- NEVER include raw URLs (`https://...`), Markdown links (`[title](url)`), or OKF footnote tags (`[^id]`) in `title` or `scriptBody`. If you reference an authority or source, name the organization or study naturally in spoken words (e.g., "According to the latest Cloud Native Computing Foundation survey...").

SOURCE RESEARCH (OKF v0.2 Concept Document):
{{researchFile}}

CRITICAL REQUIREMENT:
You must ALWAYS return a valid JSON object matching the schema. If the source research is empty, invalid, or states that it cannot find information, generate a creative placeholder script explaining the status, but DO NOT output null or empty values.

JSON ESCAPING RULES:
- Since you are outputting in JSON format, any double quotes (") inside the `title` and `scriptBody` text fields MUST be escaped as `\"`.
- Any raw newlines within string literals must be escaped as `\n`. Do not output literal, unescaped newlines in JSON values.

Generate the final output matching the JSON output schema.
