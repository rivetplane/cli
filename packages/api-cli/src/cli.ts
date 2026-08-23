#!/usr/bin/env node
import { runCli } from "./run.js";
import { createSdkClient } from "./sdk.js";

process.exitCode = await runCli(process.argv.slice(2), { createClient: createSdkClient });
