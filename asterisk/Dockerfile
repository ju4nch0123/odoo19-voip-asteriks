FROM alpine:latest

RUN apk add --no-cache asterisk asterisk-opus asterisk-srtp asterisk-sounds-en openssl

RUN mkdir -p /etc/asterisk/keys && \
    openssl req -new -newkey rsa:2048 -days 3650 -nodes -x509 \
    -subj "/CN=localhost" \
    -keyout /etc/asterisk/keys/asterisk.pem -out /etc/asterisk/keys/asterisk.pem && \
    chown -R asterisk:asterisk /etc/asterisk/keys

COPY http.conf /etc/asterisk/http.conf
COPY pjsip.conf /etc/asterisk/pjsip.conf
COPY extensions.conf /etc/asterisk/extensions.conf
COPY rtp.conf /etc/asterisk/rtp.conf
COPY modules.conf /etc/asterisk/modules.conf

RUN mkdir -p /var/lib/asterisk && \
    ln -sf /usr/share/asterisk/sounds /var/lib/asterisk/sounds && \
    chown -R asterisk:asterisk /etc/asterisk /var/spool/asterisk /var/log/asterisk /var/run/asterisk /var/lib/asterisk

USER asterisk
EXPOSE 8088 8089 10000-10100/udp

CMD ["asterisk", "-f", "-vvv"]
