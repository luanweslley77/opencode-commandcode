# opencode-commandcode

Plugin não oficial do [OpenCode](https://opencode.ai) para o [Command Code](https://commandcode.ai). Ele registra o provider `commandcode`, habilita o login por API key no `/connect`, busca o catálogo vivo de modelos, detecta o plano da assinatura e injeta os modelos disponíveis.

Funciona no OpenCode **1.x** e **2.x** com o mesmo arquivo. Não é publicado no npm e não depende do CLI do Command Code instalado.

> Este repositório não publica no npm. O pacote npm `opencode-commandcode` pertence a outro autor.

## Recursos

- Provider `commandcode` criado automaticamente via `@ai-sdk/openai-compatible` (v1) ou `@opencode/ai/providers/openai-compatible` (v2), apontando para `https://api.commandcode.ai/provider/v1`.
- `/connect` → **Command Code** → **API Key**.
- Catálogo vivo: `GET /provider/v1/models?view=client` + `GET /provider/v1/models` (contexto, reasoning efforts, modalidades, preço, plano mínimo, hidden, aliases).
- Detecção de plano: `GET /alpha/billing/subscriptions` (best-effort, cache local de 6h).
- Custo e `variants` de reasoning vindos do catálogo; `limit.output` resolvido pelo catálogo/models.dev e clampado em 200k.
- Sem auth: um modelo placeholder `Connect Command Code (/connect)` — o runtime remove providers sem modelos.
- Com auth: modelos do plano; se o nível for indeterminado, fallback `individual-max` (Go/GOAT/Pro/Max). A API responde com erro de plano se o modelo não estiver incluso.
- Cache/snapshot em `~/.cache/opencode/commandcode-*.json` (respeita `XDG_CACHE_HOME`).
- v1: sincroniza o bloco `provider.commandcode.models` do `opencode.jsonc` **somente se o bloco já existir**, preservando comentários, LF/CRLF e gerando `.bak`; v2: registra provider/modelos em memória, sem escrever no config.

## Instalação (sem publicar no npm)

O formato do spec muda entre v1 e v2. Adicione ao `opencode.json`/`opencode.jsonc` o spec com prefixo `git+`, que funciona nos dois:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["git+https://github.com/luanweslley77/opencode-commandcode.git"]
}
```

Reinicie o opencode. Na primeira vez ele instala o repo via git — o `package.json` define os entrypoints usados pelo v1 e pelo v2 — e cacheia. Não é preciso declarar `provider.commandcode`: o plugin cria o provider.

> **v2:** não use `https://github.com/...` sem o prefixo `git+`. O loader do v2 tenta resolver o plugin como caminho local antes de instalar; a URL vira um caminho inválido (`./https:/github.com/...`) e o plugin falha sem nem tentar o install. O prefixo `git+` marca o spec como repositório git. Também funcionam no v2 `github:luanweslley77/opencode-commandcode` e `git@github.com:luanweslley77/opencode-commandcode.git` (este último precisa de chave SSH). No v1, a URL sem prefixo também funciona.

Na v2, `plugins` é a chave nativa (aceita string ou `{ package, options }`); `plugin` continua funcionando como compatibilidade para strings e tuplas.

### Atualizar o plugin instalado pela URL

O opencode cacheia plugins git. No v2, rode `opencode plugin update` ou remova o cache (`~/.cache/opencode/npm`); no v1, remova `~/.cache/opencode/packages`. Para fixar uma versão, use um commit no spec (funciona nos dois):

```json
"plugin": ["git+https://github.com/luanweslley77/opencode-commandcode.git#<sha>"]
```

### Desenvolvimento local (symlink/diretório)

```bash
git clone https://github.com/luanweslley77/opencode-commandcode.git ~/opencode-commandcode
mkdir -p ~/.config/opencode/plugins
ln -sf ~/opencode-commandcode/command_code.ts ~/.config/opencode/plugins/command_code.ts
```

Use esta opção **no lugar** do spec no `plugin` (os dois juntos carregariam o plugin duas vezes). O symlink é auto-descoberto no v1 e no v2.

Também é possível apontar o config para o diretório do repositório, que funciona nos dois:

```json
"plugin": ["file:///home/SEU_USUARIO/opencode-commandcode"]
```

No v2 o alvo do config precisa ser um **diretório**: apontar direto para o arquivo (`file:///.../command_code.ts`) só funciona no v1. Para o v2 carregar um arquivo solto, deixe-o (ou um symlink) em `~/.config/opencode/plugins/`, como acima.

## Uso

1. `/connect` (ou `opencode auth login`) e selecione **Command Code**.
2. Cole a API key.
3. Reinicie o opencode. O plano é detectado e os modelos do plano são injetados.
4. `/models` para escolher.

Antes do `/connect`, o provider aparece com um único placeholder. Depois do `/connect`, reinicie: o config/plugin não é hot-reloaded (no v1) e o setup do v2 roda no startup.

## Plano

- Detectado em `/alpha/billing/subscriptions`; cache em `~/.cache/opencode/commandcode-plan.json` (6h).
- Sem key (ou key inválida): placeholder.
- Key válida + plano indeterminado: fallback `individual-max`.
- Override: `COMMAND_CODE_PLAN=GOAT|Pro|Max` ou opção `plan` no registro do plugin (veja abaixo).
- Para forçar redetecção: apague o cache do plano.

O formato do registro muda entre v1 e v2:

**v1** (`plugin` com tupla):

```json
"plugin": [["git+https://github.com/luanweslley77/opencode-commandcode.git", { "plan": "GOAT" }]]
```

**v2** (`plugins` com objeto; a tupla do v1 acima também funciona em `plugin` e é convertida pelo v2):

```json
"plugins": [{ "package": "git+https://github.com/luanweslley77/opencode-commandcode.git", "options": { "plan": "GOAT" } }]
```

## Compatibilidade

- OpenCode 1.19.5 (v1) testado; OpenCode 2.x suportado pelo mesmo default export `{ id, server, setup }` (o loader v1 usa `server`; o v2 usa `setup`).
- Linux/macOS/Windows: caminhos XDG/`~`, CRLF preservado, escrita atômica com fallback.
- Config pretty-printed (modelos em várias linhas) no v1: o sync do arquivo é cancelado para não corromper o JSON; a injeção em memória continua.

## Segurança

- A API key é lida do auth store do opencode (v1) ou da credencial da integração (v2) apenas para detectar o plano. O plugin não loga a key.
- O catálogo é público; a detecção de plano usa a key e vai para `api.commandcode.ai`.
- O endpoint de plano é alpha e não documentado; falhas caem no cache/fallback.

## Licença

MIT. Copyright (c) 2026 Luan Weslley. Veja [LICENSE](LICENSE). Não afiliado ao Command Code.
