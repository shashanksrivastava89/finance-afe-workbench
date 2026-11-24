"use strict";
// Start the app for local development, on the docker-compose Postgres when it is running.
//
// The server runs in THIS process — `require`, not `spawn` — so whoever started it can stop it.
// A wrapper that shells out to node leaves the real server holding the port when the wrapper is
// killed, which is how port 8080 ended up occupied by a process nothing was tracking.
//
//   node tools/run-local.js          # Postgres if the container is up, memory otherwise
//   docker compose up -d db          # start that container
//
// Precedence: DATABASE_URL if the environment already sets it, then AFE_DATABASE_URL, then the
// local container. A real database is always passed in; none of them is ever read from the repo.
const { execFileSync } = require("child_process");

function composeDatabaseUrl() {
  let running = "";
  try {
    running = execFileSync("docker", ["ps", "--filter", "name=afe-postgres", "--filter", "status=running", "--format", "{{.Names}}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).trim();
  } catch {
    return null;                                   // no Docker on this machine: run in memory
  }
  if (!running) return null;
  const port = process.env.POSTGRES_PORT || "5434";
  // sslmode=disable because the container speaks no TLS. Anything remote is encrypted by
  // default — lib/repos/pgStore.js decides from the URL, never from the host name — and this
  // password is the development default from docker-compose.yml, not a secret.
  return `postgres://afe:afe_dev@127.0.0.1:${port}/afe?sslmode=disable`;
}

// Local development has no Easy Auth in front of it, so the app would 401 every request.
// These two say, explicitly and only here, that this process is a development one: the
// "view as" tool is on, and a request with no SSO header is the developer. Neither is set in
// server.js and neither has a default — a deployed environment gets them from App Service
// settings or does not get them at all.
if (!process.env.DEMO_MODE) process.env.DEMO_MODE = "1";
if (!process.env.UNAUTHENTICATED_AS) process.env.UNAUTHENTICATED_AS = "shashank_srivastava@example.com";

if (!process.env.DATABASE_URL) {
  const url = process.env.AFE_DATABASE_URL || composeDatabaseUrl();
  if (url) {
    process.env.DATABASE_URL = url;
    console.log(process.env.AFE_DATABASE_URL ? "Using Postgres from AFE_DATABASE_URL."
      : "Using the local Postgres from docker-compose.");
  } else {
    console.log("No database — in-memory store; DocuSign simulated; mail as .eml download.");
  }
}

require("../server.js");
