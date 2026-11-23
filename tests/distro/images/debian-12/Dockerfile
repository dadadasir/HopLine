FROM debian:12
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server sudo procps iproute2 && rm -rf /var/lib/apt/lists/* && rm -f /etc/ssh/ssh_host_*
COPY setup.sh /usr/local/bin/hopline-setup
COPY entrypoint.sh /usr/local/bin/hopline-entrypoint
COPY sshd_config /etc/ssh/sshd_config
RUN sh /usr/local/bin/hopline-setup && chmod 755 /usr/local/bin/hopline-entrypoint
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/hopline-entrypoint"]
CMD ["/usr/sbin/sshd", "-D", "-e"]
