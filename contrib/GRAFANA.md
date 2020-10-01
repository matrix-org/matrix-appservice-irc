# Grafana README

You can use the provided `grafana.json` dashboard to view metrics for the bridge on Grafana. The dashboard uses the `bridge` label to name bridges
in a human friendly manner. The prometheus scrape config section below shows how you can add the bridge label to metrics.

```yaml
- job_name: matrix-appservice-irc
  scrape_interval: 15s
  scrape_timeout: 15s
  metrics_path: /metrics
  scheme: http
  static_configs:
  - targets:
    - lethe.int.matrix.org:3500
    labels:
      bridge: irc/freenode
  - targets:
    - lethe.int.matrix.org:3501
    labels:
      bridge: irc/oftc
```
