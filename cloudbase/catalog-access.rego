package authz.user

# 仅开放同一公共只读目录函数的固定 HTTP 网关入口。
# 目录函数仅接受 getCatalog，其余动作在访问数据库前被拒绝。

allow if {
    input.cloudbase.entrypoint_type == "tcbgateway"
    input.cloudbase.resource_type == "functions"
    input.request.host == "guoman-d1goxm3hhb53752a4-1315191445.ap-shanghai.app.tcloudbase.com"
    input.request.method in {"POST", "OPTIONS"}
    input.request.path == "/api/catalog"
}
