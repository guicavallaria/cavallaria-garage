# Kanban de OS — AWDYNA no mesmo quadro (30/10/2026)

A AWDYNA segue o mesmo padrão da Cavallaria: mesmas 9 fases, checklists, linha do tempo, Launch, perfis e auditoria. O quadro é um só, e cada card da AWDYNA traz o selo **AWDYNA**. O filtro **Empresa** mostra só uma delas.

## Veículo com OS nas duas empresas

Fica com **dois cards independentes**, um em cada empresa: fase, mecânico, checklists e linha do tempo são separados. O card é identificado por empresa + número da OS, então o mesmo número de OS nas duas empresas também não dá conflito.

## Leitura do Onmotor

- A cada rodada, o kanban lê `cavallaria.onmotor.com.br` e depois `awdyna.onmotor.com.br`, com o mesmo login (`ONMOTOR_USER` / `ONMOTOR_PASS`).
- **Carga inicial por empresa:** na primeira leitura da AWDYNA, todas as OS abertas viram card, na fase da etapa mais avançada do Onmotor, como foi com a Cavallaria. Depois disso, OS nova nasce na fase 1. OS que já chega finalizada não vira card.
- **Falha isolada:** se uma empresa falhar, a outra continua normalmente e os cards da que falhou não mudam. O aviso de "sincronização parada" diz qual empresa parou. A rodada só conta como erro quando as duas falham.
- Para tirar a AWDYNA da leitura sem mexer nos cards que já existem: `KANBAN_AWDYNA_ENABLED=false`.

## Relatórios Launch

Um relatório tem um card só. Se o chassi tiver card ativo nas duas empresas, ele vai para a OS com **entrada mais próxima** da data do escaneamento. Se tiver ido para a errada, desvincule no card; ele aparece em **🔬 Launch** com os dois cards sugeridos, com a empresa indicada.

## PDFs e links

Os PDFs saem com logo, razão, CNPJ e e-mail da empresa da OS (`kanban/empresa.js`). Os dados da AWDYNA vieram do gerador de termos (`termos-cavallaria/config.json`). A página de link vencido ou cancelado também mostra a empresa certa.

## Desenvolvimento

`KANBAN_MOCK_NOVIDADES_AWDYNA` aponta para o arquivo da Novidades simulada da AWDYNA. Sem ele, no modo `KANBAN_FONTE=mock`, o kanban lê só a Cavallaria.
