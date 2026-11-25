# Alpine wrapper so notify.sh (runOnReady/runOnNotReady) can call the backend.
FROM alpine:3.20
RUN apk add --no-cache curl ca-certificates
COPY --from=bluenviron/mediamtx:1.9.3 /mediamtx /mediamtx
COPY mediamtx.dev.yml /mediamtx.yml
COPY notify.sh /scripts/notify.sh
RUN chmod +x /scripts/notify.sh
ENTRYPOINT ["/mediamtx"]
CMD ["/mediamtx.yml"]
