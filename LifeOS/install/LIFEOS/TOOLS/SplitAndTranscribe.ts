#!/usr/bin/env bun

/**
 * @version 1.5.0
 * split-and-transcribe.ts
 *
 * Helper to split large audio files and transcribe them
 */

import { spawn } from "child_process";
import { chmodSync, lstatSync, mkdtempSync, rmSync, readdirSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, extname } from "path";
import { invariant } from "./Invariant";
import OpenAI from "openai";
import { createReadStream } from "fs";
import { writeFile } from "fs/promises";
import { CROSS_VENDOR } from "./models";

interface ChunkInfo {
  path: string;
  index: number;
}

/**
 * A fresh owner-only directory for this run's chunks (S106). mkdtemp creates it exclusively under an
 * unpredictable name, so nothing another local user planted can already be inside it.
 */
export function makeChunkDir(base: string = tmpdir()): string {
  const dir = mkdtempSync(join(base, "transcript-"));
  chmodSync(dir, 0o700);
  // Windows has no POSIX mode bits (stat always reports 0666); mkdtemp under the user's own temp dir is private there.
  invariant(process.platform === "win32" || (lstatSync(dir).mode & 0o777) === 0o700, `chunk dir ${dir} is not owner-only`);
  return dir;
}

/**
 * The chunks ffmpeg wrote, in order: only names the segment pattern generates (chunk_NNN<ext>), and only
 * regular files. A symlink or other non-file under a generated name means the directory was tampered
 * with, so the run stops rather than upload whatever it points at (S106).
 */
export function collectChunks(dir: string, ext: string): ChunkInfo[] {
  const files = readdirSync(dir).filter((f) => f.startsWith("chunk_") && f.endsWith(ext) && /^\d+$/.test(f.slice("chunk_".length, f.length - ext.length)));
  files.sort();
  return files.map((file, index) => {
    const path = join(dir, file);
    if (!lstatSync(path).isFile()) throw new Error(`refusing chunk ${file}: not a regular file (symlink or special file in the chunk directory)`);
    return { path, index: index + 1 };
  });
}

/**
 * Split audio file into chunks using FFmpeg
 */
export async function splitAudioFile(
  filePath: string,
  chunkSizeMB: number = 20,
  baseDir: string = tmpdir()
): Promise<{chunks: ChunkInfo[], tempDir: string}> {
  const tempDir = makeChunkDir(baseDir);
  const cleanup = () => rmSync(tempDir, { recursive: true, force: true });

  const ext = extname(filePath);
  const chunkPattern = join(tempDir, `chunk_%03d${ext}`);

  // Calculate chunk duration (assuming ~1MB per minute for audio)
  const chunkMinutes = chunkSizeMB;

  console.log(`Splitting file into ~${chunkSizeMB}MB chunks...`);

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i",
      filePath,
      "-f",
      "segment",
      "-segment_time",
      `${chunkMinutes * 60}`, // Convert to seconds
      "-c",
      "copy",
      chunkPattern,
    ]);

    ffmpeg.stderr.on("data", (data) => {
      // FFmpeg outputs to stderr, filter for progress
      const output = data.toString();
      if (output.includes("time=")) {
        process.stdout.write(".");
      }
    });

    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup(); // a failed split never leaves its chunks behind
      reject(err);
    };

    ffmpeg.on("close", (code) => {
      if (settled) return;
      console.log(""); // New line after dots
      if (code !== 0) {
        fail(new Error(`FFmpeg exited with code ${code}`));
        return;
      }

      let chunks: ChunkInfo[];
      try {
        chunks = collectChunks(tempDir, ext);
      } catch (e) {
        fail(e as Error);
        return;
      }
      if (chunks.length === 0) {
        fail(new Error("FFmpeg produced no chunks"));
        return;
      }

      settled = true;
      console.log(`✓ Split into ${chunks.length} chunks`);
      resolve({ chunks, tempDir });
    });

    ffmpeg.on("error", (err) => fail(err));
  });
}

/**
 * Transcribe a single chunk
 */
async function transcribeChunk(
  chunk: ChunkInfo,
  openai: OpenAI,
  format: string
): Promise<string> {
  const fileStream = createReadStream(chunk.path) as any;

  const transcription = await openai.audio.transcriptions.create({
    file: fileStream,
    model: CROSS_VENDOR.openaiTranscribe,
    response_format: format === "txt" ? "text" : (format as any),
    language: "en",
  });

  return typeof transcription === "string"
    ? transcription
    : JSON.stringify(transcription, null, 2);
}

/**
 * Main function for split and transcribe
 */
export async function splitAndTranscribe(
  filePath: string,
  apiKey: string,
  format: string = "txt"
): Promise<string> {
  const openai = new OpenAI({ apiKey });

  const fileSizeMB = statSync(filePath).size / (1024 * 1024);

  console.log(`File size: ${fileSizeMB.toFixed(2)} MB (exceeds 25MB limit)`);
  console.log("Splitting file for transcription...");

  // Split file into 20MB chunks (safe margin under 25MB)
  const { chunks, tempDir } = await splitAudioFile(filePath, 20);

  try {
    const transcripts: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkSizeMB = statSync(chunk.path).size / (1024 * 1024);

      console.log(
        `\nTranscribing chunk ${chunk.index}/${chunks.length} (${chunkSizeMB.toFixed(2)} MB)...`
      );

      const transcript = await transcribeChunk(chunk, openai, format);
      transcripts.push(transcript);

      console.log(`✓ Chunk ${chunk.index} complete`);
    }

    console.log("\n✓ All chunks transcribed");

    // Merge transcripts
    let merged: string;
    if (format === "txt") {
      merged = transcripts.join("\n\n");
    } else if (format === "json") {
      // Merge JSON arrays if applicable
      merged = transcripts.join("\n");
    } else {
      // For SRT/VTT, adjust timestamps and merge
      merged = transcripts.join("\n\n");
    }

    return merged;
  } finally {
    // Cleanup temp directory
    rmSync(tempDir, { recursive: true, force: true });
    console.log("✓ Cleaned up temporary files");
  }
}

// CLI usage
if (import.meta.main) {
  const filePath = process.argv[2];
  const format = process.argv[3] || "txt";

  if (!filePath) {
    console.error("Usage: bun split-and-transcribe.ts <file> [format]");
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY not set");
    process.exit(1);
  }

  splitAndTranscribe(filePath, process.env.OPENAI_API_KEY, format)
    .then((transcript) => {
      console.log("\nFinal transcript:\n");
      console.log(transcript);
    })
    .catch((error) => {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    });
}
