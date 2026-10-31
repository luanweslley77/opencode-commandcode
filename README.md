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

Adicione ao `opencode.json`/`opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["https://github.com/luanweslley77/opencode-commandcode"]
}
```

Reinicie o opencode. Na primeira vez ele instala o repo via git — o `package.json` define os entrypoints usados pelo v1 e pelo v2 — e cacheia. Não é preciso declarar `provider.commandcode`: o plugin cria o provider.

### Atualizar o plugin instalado pela URL

O opencode cacheia plugins git. Para pegar uma versão nova, remova o cache (`~/.cache/opencode/packages` no v1, `~/.cache/opencode/npm` no v2) ou fixe um commit na URL:

```json
"plugin": ["https://github.com/luanweslley77/opencode-commandcode.git#<sha>"]
```

### Desenvolvimento local (symlink/file)

```bash
git clone https://github.com/luanweslley77/opencode-commandcode.git ~/opencode-commandcode
mkdir -p ~/.config/opencode/plugins
ln -sf ~/opencode-commandcode/command_code.ts ~/.config/opencode/plugins/command_code.ts
```

Use esta opção **no lugar** da URL no `plugin` (as duas juntas carregariam o plugin duas vezes). O symlink é seguido no v1 e no v2.

Também é possível apontar direto para o arquivo:

```json
"plugin": ["file:///home/SEU_USUARIO/opencode-commandcode/command_code.ts"]
```

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
- Override: `COMMAND_CODE_PLAN=GOAT|Pro|Max` ou opção `plan` no registro do plugin (`["https://github.com/luanweslley77/opencode-commandcode", { "plan": "GOAT" }]`).
- Para forçar redetecção: apague o cache do plano.

## Compatibilidade

- OpenCode 1.19.5 (v1) testado; OpenCode 2.x suportado pelo mesmo default export `{ id, server, setup }` (o loader v1 usa `server`; o v2 usa `setup`).
- Linux/macOS/Windows: caminhos XDG/`~`, CRLF preservado, escrita atômica com fallback.
- Config pretty-printed (modelos em várias linhas) no v1: o sync do arquivo é cancelado para não corromper o JSON; a injeção em memória continua.

## Segurança

- A API key é lida do auth store do opencode (v1) ou da credencial da integração (v2) apenas para detectar o plano. O plugin não loga a key.
- O catálogo é público; a detecção de plano usa a key e vai para `api.commandcode.ai`.
- O endpoint de plano é alpha e não documentado; falhas caem no cache/fallback.

## Licença

MIT. Não afiliado ao Command Code.
