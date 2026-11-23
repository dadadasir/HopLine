#!/bin/sh
set -eu
export LC_ALL=C

printf '%s\n' '===HOPLINE:os-release==='
cat /etc/os-release
printf '%s\n' '===HOPLINE:uname==='
uname -a
printf '%s\n' '===HOPLINE:id==='
id
printf '%s\n' '===HOPLINE:df==='
df -P
printf '%s\n' '===HOPLINE:memory==='
if command -v free >/dev/null 2>&1; then free; else cat /proc/meminfo; fi
printf '%s\n' '===HOPLINE:loadavg==='
cat /proc/loadavg
printf '%s\n' '===HOPLINE:listeners==='
if command -v ss >/dev/null 2>&1; then ss -tlnp; else netstat -tlnp; fi
printf '%s\n' '===HOPLINE:ps==='
ps -A -o pid,user,comm,args
