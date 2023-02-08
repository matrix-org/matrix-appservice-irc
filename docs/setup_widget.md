# Setup Widget

The IRC Bridge provides a user interface in the form of a Matrix widget.
This can be used within a room to link and unlink channels.

### Configuration

In order to use the setup widget, it must be enabled along with the provisioning API:
```yaml
  provisioning:
    # True to enable the provisioning HTTP endpoint. Default: false.
    enabled: true
    # Whether to enable hosting the setup widget page. Default: false.
    widget: true
```
It will be hosted on the same port as the appservice by default, at the path `/_matrix/provision/v1/static`.

### Usage

Invite the bridge user to the Matrix room, then add the widget like this (where `example.com` is a public route to your bridge's provisioning API):
```
/addwidget https://example.com/_matrix/provision/v1/static/?roomId=$matrix_room_id&widgetId=$matrix_widget_id
```


