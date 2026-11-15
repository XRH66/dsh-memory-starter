#!/usr/bin/env node
import {runInheritCli} from '../lib/inherit/cli.js';

const outcome=await runInheritCli(process.argv.slice(2));
if(outcome.exitCode)process.exitCode=outcome.exitCode;
