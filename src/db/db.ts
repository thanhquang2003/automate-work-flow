import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
create table if not exists users(
  id integer primary key autoincrement,
  username text not null unique,
  password_hash text not null,
  role text not null default 'member',
  gitlab_token_enc text,
  created_at integer not null
);
create table if not exists requests(
  id text primary key,
  title text not null,
  description text not null default '',
  perf_req text not null default '',
  nonfunc_req text not null default '',
  project_kind text not null default 'new',
  gitlab_project text,
  software_types text not null default '[]',
  run_mode text not null default 'auto',
  stage text not null default 'INTAKE',
  status text not null default 'running',
  clarify_round integer not null default 0,
  created_by integer,
  created_at integer not null,
  updated_at integer not null
);
create table if not exists attachments(
  id integer primary key autoincrement,
  request_id text not null,
  filename text not null,
  path text not null,
  size integer not null default 0,
  created_at integer not null
);
create table if not exists stage_runs(
  id integer primary key autoincrement,
  request_id text not null,
  stage text not null,
  attempt integer not null,
  status text not null,
  feedback text,
  started_at integer not null,
  finished_at integer,
  claude_session_id text,
  error text
);
create table if not exists jobs(
  id integer primary key autoincrement,
  request_id text,
  kind text not null,
  payload text not null default '{}',
  status text not null default 'queued',
  run_after integer not null default 0,
  attempts integer not null default 0,
  last_error text
);
create index if not exists idx_jobs_status on jobs(status, run_after);
create table if not exists questions(
  request_id text not null,
  id text not null,
  round integer not null,
  category text not null,
  question text not null,
  why text not null default '',
  type text not null,
  options text not null default '[]',
  suggested_answer text not null default '',
  priority text not null,
  primary key(request_id, id)
);
create table if not exists answers(
  seq integer primary key autoincrement,
  request_id text not null,
  question_id text not null,
  answer text not null,
  source text not null,
  created_at integer not null
);
create index if not exists idx_answers_req on answers(request_id, question_id);
create table if not exists survey_links(
  token text primary key,
  request_id text not null,
  round integer not null,
  expires_at integer not null,
  submitted_at integer
);
create table if not exists features(
  request_id text not null,
  id text not null,
  code text not null,
  name text not null,
  description text not null default '',
  type_code text not null default '',
  unit_test integer not null default 0,
  note text not null default '',
  kind text not null default 'function',
  primary key(request_id, id)
);
create table if not exists tasks(
  request_id text not null,
  id text not null,
  title text not null,
  feature_id text,
  depends_on text not null default '[]',
  status text not null default 'todo',
  review_rounds integer not null default 0,
  branch text,
  mr_iid integer,
  primary key(request_id, id)
);
create table if not exists test_cases(
  request_id text not null,
  id text not null,
  feature_id text,
  purpose text not null default '',
  data text not null default '',
  steps text not null default '',
  expected text not null default '',
  status1 text,
  status2 text,
  real_result text,
  evidence text not null default '[]',
  comment text,
  primary key(request_id, id)
);
create table if not exists bugs(
  request_id text not null,
  tc_id text not null,
  gitlab_iid integer,
  fix_attempts integer not null default 0,
  status text not null default 'open',
  primary key(request_id, tc_id)
);
create table if not exists events(
  id integer primary key autoincrement,
  request_id text not null,
  ts integer not null,
  level text not null,
  message text not null
);
create index if not exists idx_events_req on events(request_id, id);
create table if not exists settings(key text primary key, value text not null);
create table if not exists templates(kind text primary key, path text not null);
`;

/** Open (creating if needed) the SQLite DB and run idempotent migrations. Use ':memory:' in tests. */
export function openDb(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('pragma journal_mode = WAL; pragma busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}
