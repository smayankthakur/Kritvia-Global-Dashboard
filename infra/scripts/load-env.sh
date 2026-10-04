# shellcheck shell=bash
# Reads KEY=VALUE lines from an env file WITHOUT executing it as shell. `source .env` breaks on
# values like MAIL_FROM=Kritvia <no-reply@...> (a redirection to bash) and silently skips every
# later line, which once switched off backups and alerts. Docker Compose reads the same file.
#   . "$(dirname "$0")/load-env.sh"; load_env ../.env
load_env() {
  local file="$1" line key val
  [ -r "$file" ] || { echo "load_env: cannot read $file" >&2; return 1; }
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[2]}"; val="${BASH_REMATCH[3]}"
    if [[ "$val" =~ ^\"(.*)\"[[:space:]]*(#.*)?$ ]] || [[ "$val" =~ ^\'(.*)\'[[:space:]]*(#.*)?$ ]]; then
      val="${BASH_REMATCH[1]}"
    else
      val="${val%%[[:space:]]#*}"                     # unquoted: drop an inline " # comment"
      val="${val%"${val##*[![:space:]]}"}"            # and trailing spaces
    fi
    export "$key=$val"
  done < "$file"
}
