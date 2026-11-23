FROM rockylinux/rockylinux:9
RUN dnf install -y openssh-server sudo procps-ng iproute shadow-utils util-linux && dnf clean all && rm -f /etc/ssh/ssh_host_*
COPY setup.sh /usr/local/bin/hopline-setup
COPY entrypoint.sh /usr/local/bin/hopline-entrypoint
COPY sshd_config /etc/ssh/sshd_config
RUN sh /usr/local/bin/hopline-setup && chmod 755 /usr/local/bin/hopline-entrypoint
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/hopline-entrypoint"]
CMD ["/usr/sbin/sshd", "-D", "-e"]
