FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server sudo procps iproute2 systemd systemd-sysv dbus ufw && rm -rf /var/lib/apt/lists/* && rm -f /etc/ssh/ssh_host_*
COPY setup.sh /usr/local/bin/hopline-setup
COPY entrypoint.sh /usr/local/bin/hopline-entrypoint
COPY sshd_config /etc/ssh/sshd_config
RUN sh /usr/local/bin/hopline-setup && chmod 755 /usr/local/bin/hopline-entrypoint
RUN systemctl disable ssh.socket && systemctl enable ssh.service
ENV container=docker
STOPSIGNAL SIGRTMIN+3
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/hopline-entrypoint"]
CMD ["/sbin/init"]
