// OpenTelemetry bootstrap — exports OTLP/HTTP-protobuf to any GenAI-aware
// backend (Logfire, Phoenix, Arize, Langfuse, etc.). Spans for OpenAI and
// Anthropic SDK calls are produced by the OpenInference instrumentations.
//
// MUST be loaded BEFORE any application code that imports `pi-coding-agent`,
// `openai`, `@anthropic-ai/sdk`, `express`, `pg`, etc. Wire it up via Node's
// --import flag in package.json scripts:
//
//   tsx --env-file .env --import ./app/otel.ts app/server.ts
//
// Configuration uses the standard OpenTelemetry OTLP env vars:
//   OTEL_EXPORTER_OTLP_ENDPOINT=https://logfire-us.pydantic.dev
//   OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer pylf_v1_us_…
//   OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
//   OTEL_SERVICE_NAME=pi-pr-review-agent
//
// Prompt/response capture knobs (also settable directly as env vars per the
// OpenInference core README):
//   OPENINFERENCE_HIDE_INPUTS=true
//   OPENINFERENCE_HIDE_OUTPUTS=true
//   OPENINFERENCE_HIDE_INPUT_MESSAGES=true
//   OPENINFERENCE_HIDE_OUTPUT_MESSAGES=true
// We map a single OTEL_LOG_PROMPTS=false to all of those for convenience.

import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

import { AnthropicInstrumentation } from "@arizeai/openinference-instrumentation-anthropic";
import { OpenAIInstrumentation } from "@arizeai/openinference-instrumentation-openai";
import { SEMRESATTRS_PROJECT_NAME } from "@arizeai/openinference-semantic-conventions";

// Eagerly import the SDKs that pi-coding-agent's transitive `@mariozechner/pi-ai`
// uses, so we can pass the *already-loaded* module objects to
// `manuallyInstrument()`. Under ESM (which is what `tsx --import` gives us)
// the require-in-the-middle hook does not fire, so manual instrumentation is
// the only reliable path.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

if (process.env.OTEL_DEBUG === "true") {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "pi-pr-review-agent";

// One env-var fan-out: OTEL_LOG_PROMPTS=false → hide all prompt/completion content.
if (process.env.OTEL_LOG_PROMPTS === "false") {
  process.env.OPENINFERENCE_HIDE_INPUTS = "true";
  process.env.OPENINFERENCE_HIDE_OUTPUTS = "true";
  process.env.OPENINFERENCE_HIDE_INPUT_MESSAGES = "true";
  process.env.OPENINFERENCE_HIDE_OUTPUT_MESSAGES = "true";
}

const openaiInstrumentation = new OpenAIInstrumentation();
const anthropicInstrumentation = new AnthropicInstrumentation();

// ESM: pass the already-imported module objects directly. Calling this BEFORE
// `registerInstrumentations` is also fine; the call simply patches in place.
openaiInstrumentation.manuallyInstrument(OpenAI);
anthropicInstrumentation.manuallyInstrument(Anthropic);

registerInstrumentations({
  instrumentations: [
    ...getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-fs": { enabled: false },
      "@opentelemetry/instrumentation-dns": { enabled: false },
      "@opentelemetry/instrumentation-net": { enabled: false },
    }),
    openaiInstrumentation,
    anthropicInstrumentation,
  ],
});

const spanProcessors: SpanProcessor[] = [
  new BatchSpanProcessor(new OTLPTraceExporter()),
];
// OTEL_CONSOLE=true mirrors every finished span to stdout — useful for local
// smoke tests / debugging which attributes are actually being attached.
if (process.env.OTEL_CONSOLE === "true") {
  spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
}

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [SEMRESATTRS_PROJECT_NAME]: SERVICE_NAME,
  }),
  spanProcessors,
});

sdk.start();

const shutdown = async (signal: string): Promise<void> => {
  try {
    await sdk.shutdown();
    // eslint-disable-next-line no-console
    console.log(`[otel] flushed and shut down on ${signal}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[otel] shutdown error:", err);
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// eslint-disable-next-line no-console
console.log(
  `[otel] initialized service=${SERVICE_NAME} ` +
    `endpoint=${process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "<unset>"} ` +
    `protocol=${process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "<default>"} ` +
    `headers=${process.env.OTEL_EXPORTER_OTLP_HEADERS ? "set" : "missing"} ` +
    `instrumentations=openinference[openai,anthropic]+http+express+pg+undici`,
);
