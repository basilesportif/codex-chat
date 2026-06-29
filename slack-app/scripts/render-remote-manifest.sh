#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: slack-app/scripts/render-remote-manifest.sh [options]

Remote runtime host helper for rendering the deploy-ready Brain Slack app manifest.
By default it updates the checked-out repo, validates the rendered manifest, and
prints JSON only to stdout so it is safe to redirect over ssh.

Options:
  --no-pull          Do not run git pull --ff-only origin main before rendering
  --output FILE      Write JSON to a server-side FILE instead of stdout
  --output-dir DIR   Write brain.slack.manifest.json under a server-side DIR
  -h, --help         Show this help

All other options are passed through to render-manifest.mjs, including
--base-url, --events-path, --events-url, and --manifest.
USAGE
}

resolve_manifest_path() {
  node -e '
    import { isAbsolute, join, resolve } from "node:path";
    const [kind, value] = process.argv.slice(1);
    if (!value) process.exit(2);
    let path = value;
    if (path === "~") {
      if (!process.env.HOME) process.exit(3);
      path = process.env.HOME;
    } else if (path.startsWith("~/")) {
      if (!process.env.HOME) process.exit(3);
      path = join(process.env.HOME, path.slice(2));
    }
    const resolved = isAbsolute(path) ? path : resolve(process.cwd(), path);
    console.log(kind === "dir" ? join(resolved, "brain.slack.manifest.json") : resolved);
  ' "$1" "$2"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd -- "$script_dir/.." && pwd)"
repo_dir="$(cd -- "$app_dir/.." && pwd)"
render_script="$script_dir/render-manifest.mjs"
validate_script="$script_dir/validate-manifest.mjs"

pull=1
output_path=""
output_dir=""
render_args=()

while (($#)); do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --no-pull)
      pull=0
      ;;
    --pull)
      pull=1
      ;;
    --output)
      if (($# < 2)); then
        echo "render-remote-manifest: --output requires a value" >&2
        exit 1
      fi
      output_path="$2"
      render_args+=("$1" "$2")
      shift
      ;;
    --output-dir)
      if (($# < 2)); then
        echo "render-remote-manifest: --output-dir requires a value" >&2
        exit 1
      fi
      output_dir="$2"
      render_args+=("$1" "$2")
      shift
      ;;
    *)
      render_args+=("$1")
      ;;
  esac
  shift
done

if [[ -n "$output_path" && -n "$output_dir" ]]; then
  echo "render-remote-manifest: use either --output or --output-dir, not both" >&2
  exit 1
fi

if [[ "$pull" == "1" && -d "$repo_dir/.git" ]]; then
  git -C "$repo_dir" pull --ff-only origin main >&2
fi

if [[ -n "$output_path" || -n "$output_dir" ]]; then
  node "$render_script" "${render_args[@]}"
  if [[ -n "$output_path" ]]; then
    rendered_path="$(resolve_manifest_path file "$output_path")"
  else
    rendered_path="$(resolve_manifest_path dir "$output_dir")"
  fi
  node "$validate_script" "$rendered_path" >&2
  printf 'Rendered and validated Slack manifest at %s\n' "$rendered_path" >&2
else
  tmp="$(mktemp "${TMPDIR:-/tmp}/brain.slack.manifest.XXXXXX.json")"
  trap 'rm -f "$tmp"' EXIT
  node "$render_script" "${render_args[@]}" --output "$tmp" >&2
  node "$validate_script" "$tmp" >&2
  cat "$tmp"
fi
