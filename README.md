# Painel de Comando

Um app de desktop (janela e ícone próprios, sem navegador) com uma aba por projeto: botões para rodar o ambiente local e subir build para **homologação** ou **produção**, terminal integrado (inclusive SSH) e um espaço para guardar links, senhas e anotações.

## Instalar

```bash
cd ~/projetos/painel-de-comando
bash install.sh
```

Isso instala as dependências (incluindo o Electron, que é o Chromium embutido, como o VS Code), cria o ícone na área de trabalho e no menu, e faz o painel abrir sozinho ao entrar na sessão. Para abrir agora: `bin/painel`.

Se o Electron não puder ser baixado, o painel abre num navegador baseado em Chromium (Chrome, Brave, Edge, Vivaldi ou Opera) em modo aplicativo.

## Como usar

- **Projetos:** aba no topo. `+` adiciona outro. Alt+1 a Alt+9 trocam de projeto.
- **Ações:** `+ Adicionar` na coluna da esquerda. Informe o nome do botão, o comando e como ele roda. Em *Ambiente* escolha Homologação ou Produção para o painel pedir confirmação antes de executar.
- **Conexões:** o comando SSH do servidor (por exemplo `ssh usuario@servidor`). O terminal é interativo, então senha e confirmações funcionam.
- **Info:** links, usuários e senhas. Tipo *Segredo* aparece oculto; *Mostrar* revela por 15 segundos e *Copiar* manda para a área de transferência.
- **Anotações:** campo livre por projeto, salvo sozinho.
- **Atalhos da janela:** F5 ou Ctrl+R recarregam, F12 abre as ferramentas de desenvolvedor.
- **Terminais** continuam rodando se você fechar a janela. Esc duas vezes dentro do terminal devolve o foco ao painel.

## Novidades desta versão

- **Scripts que abrem várias abas:** se o seu script chama `gnome-terminal --tab ...`, cada aba vira uma aba do painel (Backend, Frontend...). O botão da ação fica "Rodando" enquanto houver aba ativa e "Parar" encerra todas.
- **Novo terminal:** o botão de mais ao lado das abas abre um shell livre na pasta do projeto, quantos quiser.
- **Remover:** lixeira em cada ação, conexão e informação, sempre com confirmação.
- **Info em destaque:** cada informação é um cartão com borda, nome em negrito e tipo. Tipo novo "Usuário e senha" (login, senha oculta, copiar separado).
- **Tamanho do terminal:** A− / A+ (ou Ctrl++, Ctrl+-, Ctrl+0, Ctrl+roda do mouse), divisor arrastável entre coluna lateral e terminal, e botão para ampliar o terminal.

## Onde ficam os dados

`~/.config/painel/painel.json` (permissão 600, em texto simples). A última versão anterior fica em `painel.json.bak`. A chave de acesso fica em `~/.config/painel/token`. Não coloque essa pasta em um repositório git.

## Segurança

A janela só carrega conteúdo local e abre links externos no seu navegador padrão. O serviço escuta só em `127.0.0.1`, exige a chave de acesso (por isso o ícone abre `bin/painel`) e confere Host e Origin, para que nenhum site aberto no navegador consiga mandar comandos ao seu terminal.

## Remover

`bash install.sh --remover` (os dados em `~/.config/painel` ficam).
