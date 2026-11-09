"""Safe, actionable task failure summaries for canvas history."""

_MESSAGES = {
    'authentication': '服务商拒绝了请求：认证失败。请检查 API Key 和模型权限后重试。',
    'model_not_found': '服务商拒绝了请求：所选模型不存在或不可用。请更换模型后重试。',
    'rate_limit': '服务商拒绝了请求：当前频率或额度受限。请检查额度或稍后重试。',
    'timeout': '等待服务商响应超时；客户端无法确认任务是否已完成或计费。请先核对服务商任务记录。',
    'ambiguous_outcome': '提交后连接中断；客户端无法确认任务是否已完成或计费。请先核对服务商任务记录。',
    'protocol_incompatible': '服务商返回内容与当前生成格式不兼容，未得到可用结果；是否完成或计费无法从本地确认。请核对服务商任务记录及模型/API 格式。',
    'upstream_failure': '服务商请求失败，且没有返回可用结果。请查看服务商状态或请求编号后再试。',
}
_DEFINITIVE_REJECTIONS = {'authentication', 'model_not_found', 'rate_limit'}
_LOCAL_FAILURES = {
    '服务未返回图片': '服务商已响应，但没有返回图片；是否计费无法从本地确认。请核对服务商任务记录，再检查模型能力或提示词。',
    '生成图尺寸与原图不一致，无法安全合成': '服务商返回的图片尺寸与原图不一致，编辑结果未保存；是否计费无法从本地确认。请核对服务商任务记录。',
    '文本结果无效': '服务商未返回有效文本；是否计费无法从本地确认。请核对服务商任务记录及模型输出能力。',
}


def canvas_task_failure(exc):
    category = getattr(exc, 'category', None)
    if category not in _MESSAGES:
        last_error = getattr(exc, 'last_error', None)
        if last_error is not None and last_error is not exc:
            return canvas_task_failure(last_error)
    if category not in _MESSAGES and isinstance(exc, TimeoutError):
        category = 'timeout'

    message = _MESSAGES.get(category)
    if message is None:
        message = _LOCAL_FAILURES.get(str(exc), '任务处理失败；未获得可用结果。请查看应用日志中的安全诊断信息。')

    diagnostic = getattr(exc, 'diagnostic', None)
    if diagnostic is not None:
        status = getattr(diagnostic, 'http_status', None)
        code = getattr(diagnostic, 'provider_code', None)
        request_id = getattr(diagnostic, 'request_id', None)
        details = []
        if isinstance(status, int) and not isinstance(status, bool):
            details.append(f'HTTP {status}')
        if isinstance(code, str) and code and len(code) <= 100:
            details.append(f'错误码 {code}')
        if isinstance(request_id, str) and request_id and len(request_id) <= 160:
            details.append(f'请求编号 {request_id}')
        if details:
            message += '（' + '；'.join(details) + '）'

    return {'status': 'failed' if category in _DEFINITIVE_REJECTIONS else 'unknown', 'message': message}
