#!/usr/bin/env bash
# Prints the Homebrew formula for a release.
#   homebrew-formula.sh <version> <checksums file>
# The checksums file has `sha256sum` lines for the release's four archives,
# elseagent-<version>-<os>-<arch>.tar.gz.
set -euo pipefail

version="$1"
checksums="$2"
repo="${GITHUB_REPOSITORY:-elsescape/elseagent}"

url() {
  echo "https://github.com/${repo}/releases/download/v${version}/elseagent-${version}-$1.tar.gz"
}

sha() {
  local sum
  sum="$(awk -v file="elseagent-${version}-$1.tar.gz" '$2 == file || $2 == "*" file { print $1 }' "$checksums")"
  if [[ ! "$sum" =~ ^[0-9a-f]{64}$ ]]; then
    echo "no checksum for $1 in $checksums" >&2
    exit 1
  fi
  echo "$sum"
}

# Looked up first: a failure inside the here-document below would go unnoticed.
sha_darwin_arm64="$(sha darwin-arm64)"
sha_darwin_x64="$(sha darwin-x64)"
sha_linux_arm64="$(sha linux-arm64)"
sha_linux_x64="$(sha linux-x64)"

cat <<EOF
class Elseagent < Formula
  desc "Codex agent for Slack and Telegram"
  homepage "https://github.com/${repo}"
  version "${version}"

  on_macos do
    on_arm do
      url "$(url darwin-arm64)"
      sha256 "${sha_darwin_arm64}"
    end
    on_intel do
      url "$(url darwin-x64)"
      sha256 "${sha_darwin_x64}"
    end
  end

  on_linux do
    on_arm do
      url "$(url linux-arm64)"
      sha256 "${sha_linux_arm64}"
    end
    on_intel do
      url "$(url linux-x64)"
      sha256 "${sha_linux_x64}"
    end
  end

  def install
    bin.install "elseagent"
  end

  def caveats
    <<~EOS
      Install the Codex CLI and make it available on PATH.
      Run elseagent init, configure Slack or Telegram in ~/.elseagent.yaml,
      then start the agent with elseagent run.

      Setup: https://github.com/${repo}/blob/main/docs/usage.md
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/elseagent --version").strip
  end
end
EOF
