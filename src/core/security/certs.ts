// Shared by inventory and security collection; no certificate contents leave the host.
export const CERT_SCRIPT = String.raw`
collect_certs() {
  command -v openssl >/dev/null 2>&1 || { unavailable not-installed openssl; return; }
  config=$(nginx -T 2>/dev/null)
  if [ $? -ne 0 ]; then
    config=$(cat /etc/nginx/nginx.conf /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf 2>/dev/null)
    [ -z "$config" ] || printf '#HOPLINE-PARTIAL nginx configuration not expanded\n'
  fi
  refs=$(printf '%s\n' "$config" | sed 's/#.*//' | awk '{for(i=1;i<NF;i++) if($i=="ssl_certificate") {v=$(i+1); gsub(/[;"\047]/,"",v); print v}}' | sort -u)
  for dir in /etc/nginx /etc/letsencrypt /etc/letsencrypt/live /var/lib/caddy /var/lib/caddy/.local/share/caddy; do
    if [ -d "$dir" ] && { [ ! -r "$dir" ] || [ ! -x "$dir" ]; }; then unavailable permission-denied "$dir"; fi
  done
  printf '%s\n' "$refs" | while IFS= read -r file; do
    [ -n "$file" ] || continue
    case "$file" in /*) ;; *) printf '#HOPLINE-PARTIAL unresolved certificate path\n'; continue ;; esac
    printf '#HOPLINE-CERT referenced\n'; run openssl x509 -in "$file" -noout -enddate -subject
  done
  caddy_files=$(find /var/lib/caddy/.local/share/caddy/certificates -type f -name '*.crt' 2>/dev/null)
  if [ $? -ne 0 ] && [ -d /var/lib/caddy/.local/share/caddy/certificates ]; then unavailable permission-denied 'caddy certificates'; fi
  caddy_files=$(printf '%s\n' "$caddy_files" | head -n 100)
  printf '%s\n' "$caddy_files" | while IFS= read -r file; do
    [ -n "$file" ] || continue
    printf '#HOPLINE-CERT unreferenced\n'; run openssl x509 -in "$file" -noout -enddate -subject
  done
  for dir in /etc/letsencrypt/live/*; do
    if [ -d "$dir" ] && { [ ! -r "$dir" ] || [ ! -x "$dir" ]; }; then unavailable permission-denied "$dir"; fi
  done
  for file in /etc/letsencrypt/live/*/cert.pem; do
    [ -e "$file" ] || continue
    dir=$(dirname "$file")
    if printf '%s\n' "$refs" | grep -F -x "$file" >/dev/null || printf '%s\n' "$refs" | grep -F -x "$dir/fullchain.pem" >/dev/null; then continue; fi
    printf '#HOPLINE-CERT unreferenced\n'; run openssl x509 -in "$file" -noout -enddate -subject
  done
}
`
