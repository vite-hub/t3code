#!/usr/bin/env bash
# Merge upstream into the fork's checked-out branch and report the outcome.
#
#   sync-upstream.sh merge [--upstream-ref REF]
#   sync-upstream.sh report --failed-step NAME [--dry-run]
#   sync-upstream.sh resolve [--dry-run]
#
# `merge` keeps fork-owned workflows, resolves a lockfile-only conflict by
# taking upstream's lockfile and regenerating it, and stops on any other
# conflict after writing the file list to $SYNC_STATE_DIR/conflicts.txt.
# `report` opens or updates the single open issue labelled $SYNC_ISSUE_LABEL.
# `resolve` closes that issue after a green sync. --dry-run prints instead of
# calling GitHub.
set -euo pipefail

LOCKFILE=pnpm-lock.yaml
LOCKFILE_CMD=${SYNC_LOCKFILE_CMD:-vp install --lockfile-only --ignore-scripts}
STATE_DIR=${SYNC_STATE_DIR:-${RUNNER_TEMP:-/tmp}/sync-upstream}
LABEL=${SYNC_ISSUE_LABEL:-upstream-sync}
TITLE="Upstream sync needs a manual merge"
UPSTREAM_REPO=${SYNC_UPSTREAM_REPO:-pingdotgg/t3code}

run_url() {
  if [[ -n "${GITHUB_RUN_ID:-}" ]]; then
    echo "${GITHUB_SERVER_URL:-https://github.com}/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
  else
    echo "(local run, no workflow link)"
  fi
}

set_output() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi
  echo "$1=$2"
}

cmd_merge() {
  local ref=upstream/main
  while [[ $# -gt 0 ]]; do
    case $1 in
      --upstream-ref) ref=$2; shift 2 ;;
      *) echo "unknown merge option: $1" >&2; exit 2 ;;
    esac
  done
  mkdir -p "$STATE_DIR"
  rm -f "$STATE_DIR/conflicts.txt"
  git rev-parse "$ref" > "$STATE_DIR/upstream-sha.txt"
  git rev-parse HEAD > "$STATE_DIR/fork-sha.txt"

  if git merge-base --is-ancestor "$ref" HEAD; then
    set_output changed false
    return 0
  fi

  local base
  base=$(git merge-base HEAD "$ref")
  git diff --name-status "$base" "$ref" -- .github/workflows > "$STATE_DIR/upstream-workflows.txt"

  # Workflows are fork-owned. GITHUB_TOKEN cannot push upstream workflow
  # changes, and the fork has different release and package operations.
  git merge --no-commit --no-ff "$ref" || true
  git restore --source=HEAD --staged --worktree -- .github/workflows

  local conflicts
  conflicts=$(git diff --name-only --diff-filter=U)
  if [[ "$conflicts" == "$LOCKFILE" ]]; then
    echo "Only $LOCKFILE conflicts: taking upstream's and regenerating it"
    git checkout --theirs -- "$LOCKFILE"
    $LOCKFILE_CMD
    git add -- "$LOCKFILE"
    conflicts=$(git diff --name-only --diff-filter=U)
  fi
  if [[ -n "$conflicts" ]]; then
    printf '%s\n' "$conflicts" > "$STATE_DIR/conflicts.txt"
    printf 'Unresolved upstream conflicts:\n%s\n' "$conflicts" >&2
    exit 1
  fi

  git commit --no-edit
  set_output changed true

  if [[ -s "$STATE_DIR/upstream-workflows.txt" && -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    echo "::warning title=Upstream workflows preserved::Review the workflow changes listed in the job summary"
    {
      echo "### Upstream workflow changes need manual review"
      echo
      echo '```text'
      cat "$STATE_DIR/upstream-workflows.txt"
      echo '```'
    } >> "$GITHUB_STEP_SUMMARY"
  fi
}

issue_body() {
  local step=$1 upstream fork
  upstream=$(cat "$STATE_DIR/upstream-sha.txt" 2>/dev/null || echo unknown)
  fork=$(cat "$STATE_DIR/fork-sha.txt" 2>/dev/null || echo unknown)
  echo "The daily Sync upstream workflow could not advance \`main\`."
  echo
  echo "- Failed step: $step"
  echo "- Run: $(run_url)"
  echo "- Fork \`main\`: $fork"
  echo "- Upstream \`$UPSTREAM_REPO\` main: $upstream"
  if [[ -s "$STATE_DIR/conflicts.txt" ]]; then
    echo
    echo "Conflicting files (workflows are kept from the fork, and a lockfile-only conflict resolves itself):"
    echo
    sed 's/^/- `/; s/$/`/' "$STATE_DIR/conflicts.txt"
  fi
  echo
  echo "Merge \`upstream/main\` into a \`sync/upstream-<date>\` branch by hand, fix the conflicts or the failing check, and open a PR to \`main\`. The next green sync closes this issue."
}

open_issue() {
  gh issue list --label "$LABEL" --state open --json number --jq '.[0].number // empty'
}

cmd_report() {
  local step="" dry=false
  while [[ $# -gt 0 ]]; do
    case $1 in
      --failed-step) step=$2; shift 2 ;;
      --dry-run) dry=true; shift ;;
      *) echo "unknown report option: $1" >&2; exit 2 ;;
    esac
  done
  [[ -n "$step" ]] || { echo "report needs --failed-step" >&2; exit 2; }
  local body
  body=$(issue_body "$step")
  if $dry; then
    printf 'Would open or update issue "%s" [label %s]:\n\n%s\n' "$TITLE" "$LABEL" "$body"
    return 0
  fi
  gh label create "$LABEL" --color d93f0b \
    --description "Daily upstream sync needs a manual merge" --force >/dev/null
  local number
  number=$(open_issue)
  if [[ -n "$number" ]]; then
    gh issue edit "$number" --body "$body" >/dev/null
    gh issue comment "$number" --body "Failed again in $(run_url) ($step)." >/dev/null
    echo "Updated issue #$number"
  else
    gh issue create --title "$TITLE" --label "$LABEL" --body "$body"
  fi
}

cmd_resolve() {
  local dry=false
  [[ "${1:-}" == --dry-run ]] && dry=true
  local note="Sync upstream is green again in $(run_url) (fork \`main\` at $(git rev-parse HEAD))."
  if $dry; then
    printf 'Would close the open "%s" issue with: %s\n' "$LABEL" "$note"
    return 0
  fi
  local number
  number=$(open_issue)
  if [[ -n "$number" ]]; then
    gh issue close "$number" --comment "$note"
  fi
}

case ${1:-} in
  merge) shift; cmd_merge "$@" ;;
  report) shift; cmd_report "$@" ;;
  resolve) shift; cmd_resolve "$@" ;;
  *) echo "usage: $0 merge|report|resolve [options]" >&2; exit 2 ;;
esac
