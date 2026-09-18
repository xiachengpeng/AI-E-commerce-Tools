"""Security utilities for validating outbound URLs and hostnames against SSRF attacks."""

import ipaddress
import os
import socket
import urllib.parse
from typing import Tuple

_CLOUD_METADATA_HOSTS = {
    "169.254.169.254",
    "metadata.google.internal",
    "instance-data",
    "metadata.internal",
}

_PROXY_OR_NAT_NETWORKS = (
    ipaddress.IPv4Network("198.18.0.0/15"),  # RFC 2544 benchmark / proxy Fake-IP pool (Clash, Surge, etc.)
    ipaddress.IPv4Network("100.64.0.0/10"),  # RFC 6598 Carrier-Grade NAT (CGNAT)
)


def _is_cloud_metadata(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return str(ip) == "169.254.169.254" or ip.is_link_local


def _is_allowed_address(
    address: ipaddress.IPv4Address | ipaddress.IPv6Address,
    is_literal: bool = False,
    allow_local: bool = False,
) -> Tuple[bool, str]:
    # Cloud metadata is NEVER allowed, even if allow_local is True
    if _is_cloud_metadata(address):
        return False, "禁止访问云元数据或链路本地保留地址"

    if address.is_multicast or address.is_unspecified or address.is_reserved:
        return False, "禁止访问多播或保留网段地址"

    if address.is_loopback:
        if allow_local:
            return True, ""
        return False, "禁止访问本地回环地址"

    if address.is_global:
        return True, ""

    # Proxy Fake-IP or CGNAT resolution for public domains (e.g. Clash/Surge Fake-IP pool 198.18.0.0/15)
    if not is_literal and isinstance(address, ipaddress.IPv4Address):
        for network in _PROXY_OR_NAT_NETWORKS:
            if address in network:
                return True, ""

    if address.is_private:
        if allow_local:
            return True, ""
        return False, "禁止直接请求内网私有地址"

    return False, "目标 IP 属于未授权的受限网段"


def validate_outbound_url(
    url_or_host: str,
    allow_local: bool | None = None,
    require_http: bool = True,
) -> Tuple[bool, str]:
    """
    Validate that an outbound URL or host does not target internal services or cloud metadata.
    Returns (is_safe: bool, error_message: str).
    """
    if not url_or_host or not url_or_host.strip():
        return False, "地址不能为空"

    val = url_or_host.strip()

    if allow_local is None:
        allow_local = os.getenv("ALLOW_LOCAL_STORAGE_TARGETS", "").strip().lower() in ("1", "true", "yes")

    # Extract hostname and scheme
    if "://" in val:
        try:
            parsed = urllib.parse.urlparse(val)
        except Exception:
            return False, "无法解析的 URL 格式"

        if require_http and parsed.scheme.lower() not in ("http", "https"):
            return False, "协议必须为 http 或 https"

        host = (parsed.hostname or "").lower().strip()
    else:
        # Raw hostname or host:port
        host = val.split("/")[0].split(":")[0].lower().strip()

    if not host:
        return False, "无效的主机名"

    if host in _CLOUD_METADATA_HOSTS:
        return False, "禁止访问云主机元数据地址"

    if host in ("localhost", "localhost.localdomain") and not allow_local:
        return False, "禁止访问本地回环地址"

    # Check if host is a literal IP address
    try:
        literal_ip = ipaddress.ip_address(host)
        return _is_allowed_address(literal_ip, is_literal=True, allow_local=allow_local)
    except ValueError:
        pass

    # Host is a domain name; resolve DNS to check resolved target IPs
    try:
        addr_entries = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        resolved_ips = list({entry[4][0] for entry in addr_entries})
    except socket.gaierror as exc:
        return False, f"主机名无法解析: {exc}"
    except Exception as exc:
        return False, f"DNS 解析失败: {exc}"

    if not resolved_ips:
        return False, "未能解析到有效的主机 IP 地址"

    for ip_str in resolved_ips:
        try:
            ip_obj = ipaddress.ip_address(ip_str)
        except ValueError:
            return False, f"无效的解析 IP: {ip_str}"

        safe, msg = _is_allowed_address(ip_obj, is_literal=False, allow_local=allow_local)
        if not safe:
            return False, msg

    return True, ""
