package authz.user

# 仅追加目录路径允许规则；其他请求未命中时沿用平台默认策略。

allow if {
    input.cloudbase.env_id == "guoman-d1goxm3hhb53752a4"
    input.cloudbase.entrypoint_type == "tcbopenapi"
    input.cloudbase.resource_type == "functions"
    input.request.method == "POST"
    input.request.path == "/v1/functions/guoman-catalog"
}
