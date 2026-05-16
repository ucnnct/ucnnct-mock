# Demo uCNNCT Mock - scalabilite verticale et horizontale

Ce guide sert de support de presentation pour montrer comment `ucnnct-mock`
pilote de vrais utilisateurs virtuels contre `https://staging.uconnect.cc`, puis
observe le scaling du projet principal.

Le front de demo est disponible ici :

```text
http://172.31.255.240:88/
```

Le README ne contient volontairement aucun mot de passe. Les alias SSH sont ceux
de la configuration WSL locale.

## Objectif de la demo

Montrer trois choses, dans cet ordre :

1. Le mock lance de vrais virtual users avec authentification staging, appels HTTP reels et websocket reel.
2. Le vertical scaling est observable via VPA sur `media-service`.
3. Le horizontal scaling change selon le poids des actions : media, groupe, messages, notifications.

Pendant la demo, garder en tete :

- `1 identity = 1 virtual user`.
- Si `Gradual online = false`, tous les users deviennent actifs.
- Tous les users authentifies ouvrent un websocket.
- Les runs de demo courts utilisent `150 VU` pour rester lisibles.
- Le plafond technique expose par le mock reste `10000 VU`.
- Pour une demo basse volumetrie, le front permet aussi de saisir un volume manuel, par exemple `20 VU`.

## Architecture montree

```text
mock-control-center  -> front Angular de pilotage
orchestrator         -> API control-plane et orchestration des runs
worker-service       -> execution des virtual users
mock-user-service    -> provisionnement et leases des identites staging

staging.uconnect.cc  -> vraie application cible
ws-manager           -> connexions websocket reelles
HPA                  -> scaling horizontal des services metier
VPA                  -> recommandations / mutation verticale des ressources
```

## Etat attendu avant de commencer

Depuis PowerShell local :

```powershell
$Api = "http://172.31.255.240:88/api/v1/control-plane"

Invoke-RestMethod "$Api/health" | ConvertTo-Json -Depth 8
Invoke-RestMethod "$Api/user-runtime" | ConvertTo-Json -Depth 8
Invoke-RestMethod "$Api/services" | ConvertTo-Json -Depth 8
```

Points attendus :

- `status = ok` sur l'orchestrator.
- `stagingClusterReader = enabled`.
- `kubernetesWorkerController = enabled`.
- `totalUsers = 10000`.
- `availableUsers = 10000`.
- `leasedUsers = 0`.
- `activeLeases = 0`.

Depuis WSL, verifier Argo :

```bash
ssh franky
kubectl -n argocd get application uconnect-staging ucnnct-mock-staging \
  -o custom-columns=NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status,REV:.status.sync.revision,OP:.status.operationState.phase
```

Etat attendu :

```text
uconnect-staging      Synced   Healthy
ucnnct-mock-staging   Synced   Healthy
```

Verifier les services metier dans le cluster staging :

```bash
ssh rayleigh
kubectl -n staging get rollout media-service chat-service notification-service group-service user-service ws-manager \
  -o custom-columns=NAME:.metadata.name,PHASE:.status.phase,READY:.status.readyReplicas,REPLICAS:.status.replicas

kubectl -n staging get hpa media-service chat-service notification-service group-service user-service ws-manager -o wide
kubectl -n staging get vpa media-service chat-service notification-service group-service user-service ws-manager -o wide
```

Etat attendu :

- `ws-manager` healthy avec `45` pods.
- `media-service` VPA en `Recreate`.
- `chat-service`, `group-service`, `notification-service`, `user-service`, `ws-manager` VPA en `Off` pour observation.
- `media-service` a `minReplicas = 2`, necessaire pour que VPA puisse recrer un pod sans coupure.

Verifier le cluster mock :

```bash
ssh nodemaster
sudo kubectl -n ucnnct-mock get deploy orchestrator worker-service mock-user-service -o wide
sudo kubectl -n ucnnct-mock get rollout mock-control-center
sudo kubectl -n ucnnct-mock get pods -o wide
```

Image attendue pour l'orchestrator :

```text
ghcr.io/ucnnct/mock-orchestrator:0.14.1
```

## Parcours front a presenter

Ouvrir le front :

```text
http://172.31.255.240:88/
```

### 1. Page Overview

Presenter :

- nombre de runs actifs ;
- services chauds ;
- evenements de scaling ;
- etat global du systeme.

Message oral possible :

```text
Ici le mock n'est pas un simulateur local. Il lance des identites staging reelles,
ouvre des sessions websocket reelles et mesure le comportement du cluster staging.
```

### 2. Page Scaling

Presenter les blocs :

- Services / Scaling : metriques HPA staging reelles.
- Vertical scaling : VPA mode, target CPU/memory, etat `observe`, `applying` ou `applied`.
- Workers : metriques CPU/memoire reelles des noeuds workers mock.
- Scaling events : historique lisible des reactions.

Points importants :

- `media-service` est le service de demo VPA en `Recreate`.
- Les autres services sont en VPA `Off`, donc ils exposent les recommandations sans mutation automatique.
- `ws-manager` est fixe a `45` pods pour garder les connexions websocket stables pendant les scenarios.

### 3. Page Runs

Presenter le builder :

- `Virtual users` : volume choisi par l'operateur.
- `Gradual online` : pour la demo, le laisser desactive afin que tous les users se connectent.
- `Behavior weights` : poids des comportements.
- `Upload probability` : intensite des uploads media.
- Preview : shards workers, identites louees, users par shard.

Les boutons utiles pour la presentation :

- `Demo media 150` : media fort, groupe a 0.
- `Demo group 150` : groupe fort, media a 0.
- `Vertical media` : scenario media plus long pour forcer une observation VPA.
- `10k WebSockets` : validation websocket haute volumetrie, a utiliser seulement si le cluster est pret.

## Commandes live a afficher pendant la demo

Il est pratique d'ouvrir 3 terminaux :

- terminal A : front navigateur ;
- terminal B : `ssh rayleigh`, observation staging ;
- terminal C : PowerShell local, API mock ;
- terminal D optionnel : `ssh franky`, Argo.

### Terminal B - HPA en direct

Depuis `ssh rayleigh` :

```bash
watch -n 2 'kubectl -n staging get hpa media-service chat-service notification-service group-service user-service ws-manager -o wide'
```

Si `watch` n'est pas disponible :

```bash
while true; do
  clear
  kubectl -n staging get hpa media-service chat-service notification-service group-service user-service ws-manager -o wide
  sleep 2
done
```

### Terminal B - rollouts en direct

```bash
watch -n 2 'kubectl -n staging get rollout media-service chat-service notification-service group-service user-service ws-manager -o custom-columns=NAME:.metadata.name,PHASE:.status.phase,READY:.status.readyReplicas,REPLICAS:.status.replicas'
```

### Terminal B - pods par service

Media :

```bash
watch -n 2 'kubectl -n staging get pods -l app.kubernetes.io/name=media-service -o custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[0].ready,CPU_REQ:.spec.containers[0].resources.requests.cpu,MEM_REQ:.spec.containers[0].resources.requests.memory,CPU_LIM:.spec.containers[0].resources.limits.cpu,MEM_LIM:.spec.containers[0].resources.limits.memory,NODE:.spec.nodeName'
```

Groupe :

```bash
watch -n 2 'kubectl -n staging get pods -l app.kubernetes.io/name=group-service -o custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[0].ready,CPU_REQ:.spec.containers[0].resources.requests.cpu,MEM_REQ:.spec.containers[0].resources.requests.memory,NODE:.spec.nodeName'
```

Notifications :

```bash
watch -n 2 'kubectl -n staging get pods -l app.kubernetes.io/name=notification-service -o custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[0].ready,CPU_REQ:.spec.containers[0].resources.requests.cpu,MEM_REQ:.spec.containers[0].resources.requests.memory,NODE:.spec.nodeName'
```

WebSocket :

```bash
watch -n 2 'kubectl -n staging get pods -l app.kubernetes.io/name=ws-manager -o wide'
```

### Terminal B - VPA

```bash
watch -n 5 'kubectl -n staging get vpa media-service chat-service notification-service group-service user-service ws-manager -o wide'
```

Detail VPA `media-service` :

```bash
kubectl -n staging describe vpa media-service
kubectl -n staging get vpa media-service -o yaml
```

### Terminal B - metriques

```bash
kubectl top pods -n staging
kubectl top pods -n staging --containers
kubectl top nodes
```

### Terminal C - API mock pendant un run

Depuis PowerShell :

```powershell
$Api = "http://172.31.255.240:88/api/v1/control-plane"

(Invoke-RestMethod "$Api/runs").value |
  Select-Object -First 5 runName,id,status,virtualUsers,activeUsers,connectedUsers,openSockets,requestsPerSecond,messagesPerSecond,uploadsPerMinute,errorRate,p95LatencyMs |
  Format-Table -AutoSize

Invoke-RestMethod "$Api/services" | ConvertTo-Json -Depth 8
Invoke-RestMethod "$Api/user-runtime" | ConvertTo-Json -Depth 8
```

Arreter un run si necessaire :

```powershell
Invoke-RestMethod "$Api/runs/<run-id>/stop" -Method Post | ConvertTo-Json -Depth 8
```

## Scenario 1 - demo media verticale et horizontale

But :

- Montrer que la charge media impacte `media-service`.
- Montrer que `group-service` ne scale pas quand le poids groupe vaut 0.
- Montrer que VPA expose les recommandations et que `media-service` est le service en mode `Recreate`.

### Lancement depuis le front

1. Aller dans `Runs`.
2. Cliquer `Demo media 150`.
3. Verifier les valeurs :
   - `Virtual users = 150`
   - `Duration = 240`
   - `Ramp-up = 45`
   - `Gradual online = false`
   - `group = 0`
   - `media = 56`
   - `Upload probability = 0.24`
4. Cliquer `Start run`.
5. Aller dans `Scaling`.

### Lancement equivalent par API

Depuis PowerShell :

```powershell
$Api = "http://172.31.255.240:88/api/v1/control-plane"

$payload = @{
  runName = "demo-vertical-media-150"
  environment = "staging"
  virtualUsers = 150
  durationSeconds = 240
  rampUpSeconds = 45
  thinkTimeMinMs = 220
  thinkTimeMaxMs = 900
  gradualOnline = $false
  initialOnlineRatio = 1
  avgSessionDurationSeconds = 240
  weights = @{
    browse = 8
    privateMessage = 16
    group = 0
    media = 56
    social = 4
    notificationCheck = 16
  }
  media = @{
    uploadProbability = 0.24
  }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod "$Api/runs" -Method Post -ContentType "application/json" -Body $payload |
  ConvertTo-Json -Depth 8
```

### Ce qu'il faut montrer

Dans le front `Runs` :

- `connectedUsers = 150`
- `openSockets = 150`
- `uploadsPerMinute` eleve
- `send_group_message = 0`
- `upload_file` augmente
- `errorRate` reste bas

Dans le front `Scaling` et dans `kubectl` :

- `media-service` monte ou reste au-dessus de son minimum selon la fenetre HPA.
- `media-service` affiche `VPA Recreate`.
- `group-service` reste stable car le poids `group = 0`.
- `notification-service` peut monter, car les uploads et actions sociales generent des notifications.
- `chat-service` peut monter car certains flows passent encore par la messagerie.

Commandes a afficher :

```bash
kubectl -n staging get hpa media-service group-service notification-service chat-service -o wide
kubectl -n staging get vpa media-service -o wide
kubectl -n staging get pods -l app.kubernetes.io/name=media-service \
  -o custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[0].ready,CPU_REQ:.spec.containers[0].resources.requests.cpu,MEM_REQ:.spec.containers[0].resources.requests.memory,CPU_LIM:.spec.containers[0].resources.limits.cpu,MEM_LIM:.spec.containers[0].resources.limits.memory,NODE:.spec.nodeName
```

Message oral possible :

```text
Le poids media est haut et le poids groupe est nul. On voit donc media-service
et notification-service reagir, pendant que group-service reste stable. Le VPA
sur media-service donne une recommandation de ressources verticales, et le HPA
continue de controler le nombre de pods.
```

## Scenario 2 - demo group-heavy sans media

But :

- Montrer que le scaling depend du poids des actions.
- Montrer que `group-service` scale quand le poids groupe est fort.
- Montrer que `media-service` ne scale pas quand `media = 0`.
- Montrer que `chat-service` reste implique car il porte l'insertion des messages.
- Montrer que `notification-service` est impacte par les autres actions.

### Lancement depuis le front

1. Attendre que le scenario precedent soit termine.
2. Verifier `user-runtime` : `availableUsers = 10000`, `activeLeases = 0`.
3. Dans `Runs`, cliquer `Demo group 150`.
4. Verifier les valeurs :
   - `Virtual users = 150`
   - `Duration = 240`
   - `Ramp-up = 45`
   - `Gradual online = false`
   - `group = 54`
   - `media = 0`
   - `Upload probability = 0`
5. Cliquer `Start run`.
6. Aller dans `Scaling`.

### Lancement equivalent par API

```powershell
$Api = "http://172.31.255.240:88/api/v1/control-plane"

$payload = @{
  runName = "demo-group-heavy-150"
  environment = "staging"
  virtualUsers = 150
  durationSeconds = 240
  rampUpSeconds = 45
  thinkTimeMinMs = 300
  thinkTimeMaxMs = 1100
  gradualOnline = $false
  initialOnlineRatio = 1
  avgSessionDurationSeconds = 240
  weights = @{
    browse = 8
    privateMessage = 20
    group = 54
    media = 0
    social = 6
    notificationCheck = 12
  }
  media = @{
    uploadProbability = 0
  }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod "$Api/runs" -Method Post -ContentType "application/json" -Body $payload |
  ConvertTo-Json -Depth 8
```

### Ce qu'il faut montrer

Dans `Runs` :

- `connectedUsers = 150`
- `openSockets = 150`
- `messagesPerSecond` eleve
- `uploadsPerMinute = 0`
- `send_group_message` augmente fortement
- `upload_file = 0`

Dans `Scaling` et `kubectl` :

- `group-service` passe en scaling.
- `chat-service` monte aussi, car les messages de groupe finissent dans la persistence messages.
- `notification-service` reste implique, car les actions groupe/message generent des notifications.
- `media-service` reste stable, car `media = 0` et `uploadProbability = 0`.

Commandes a afficher :

```bash
kubectl -n staging get hpa group-service chat-service notification-service media-service -o wide
kubectl -n staging get rollout group-service chat-service notification-service media-service \
  -o custom-columns=NAME:.metadata.name,PHASE:.status.phase,READY:.status.readyReplicas,REPLICAS:.status.replicas
kubectl -n staging get pods -l app.kubernetes.io/name=group-service -o wide
```

Message oral possible :

```text
Ici on a inverse les poids : media vaut zero, groupe est dominant. Le service
media reste calme, tandis que group-service, chat-service et notification-service
montent. C'est exactement ce qu'on attend d'une charge orientee groupes.
```

## Scenario 3 - validation WebSocket 10000 VU

Ce scenario est plus lourd. Ne pas le lancer au milieu d'une demo courte si les
services metier sont encore en train de redescendre.

But :

- Valider que le mock peut ouvrir jusqu'a `10000` connexions websocket.
- Observer `ws-manager`.
- Verifier que les identites sont bien relachees a la fin.

Depuis le front :

1. Aller dans `Runs`.
2. Cliquer `10k WebSockets`.
3. Verifier :
   - `Virtual users = 10000`
   - `Duration = 1800`
   - `Gradual online = false`
   - tous les poids a `0`
4. Lancer seulement si :
   - `ws-manager` est healthy avec `45/45`;
   - `user-runtime.availableUsers = 10000`;
   - aucune autre demo n'est active.

Commandes utiles :

```bash
kubectl -n staging get rollout ws-manager -o wide
kubectl -n staging get pods -l app.kubernetes.io/name=ws-manager -o wide
kubectl top pods -n staging -l app.kubernetes.io/name=ws-manager
```

Depuis PowerShell :

```powershell
$Api = "http://172.31.255.240:88/api/v1/control-plane"

(Invoke-RestMethod "$Api/runs").value |
  Select-Object -First 3 runName,status,virtualUsers,connectedUsers,openSockets,errorRate,p95LatencyMs |
  Format-Table -AutoSize
```

Critere attendu :

- `connectedUsers` tend vers `10000`.
- `openSockets` tend vers `10000`.
- `ws-manager` reste ready.
- Les identites reviennent a `availableUsers = 10000` apres stop ou fin du run.

## Lecture des resultats

### Pourquoi notification-service scale souvent

`notification-service` est impacte par plusieurs actions :

- messages prives ;
- messages de groupe ;
- activite sociale ;
- consultations de notifications ;
- uploads ou evenements qui declenchent une notification.

Il est donc normal qu'il scale dans presque tous les scenarios actifs.

### Pourquoi chat-service scale aussi sur les groupes

Les messages envoyes dans les groupes impactent `group-service`, mais
`chat-service` reste implique car la persistence et l'insertion des messages
passent par le domaine message/chat.

Dans une demo group-heavy, il est donc attendu de voir :

- `group-service` monter ;
- `chat-service` monter aussi ;
- `notification-service` monter ;
- `media-service` rester stable si `media = 0`.

### Pourquoi VPA ne remplace pas HPA

HPA repond a la question :

```text
Combien de pods faut-il ?
```

VPA repond a la question :

```text
Combien de CPU/memoire faut-il par pod ?
```

Dans cette demo :

- `media-service` est en VPA `Recreate`, donc c'est le service actif pour montrer la mutation verticale.
- Les autres services sont en VPA `Off`, donc on voit les recommandations sans redemarrage automatique.
- `media-service` utilise `RequestsOnly`, donc VPA ajuste les requests sans faire exploser les limits.
- `media-service` garde `minReplicas = 2`, car l'updater VPA refuse de recrer un workload avec un seul pod disponible.

## Commandes de diagnostic rapide

Voir les runs :

```powershell
$Api = "http://172.31.255.240:88/api/v1/control-plane"
(Invoke-RestMethod "$Api/runs").value |
  Select-Object -First 10 runName,id,status,virtualUsers,activeUsers,connectedUsers,openSockets,errorRate,p95LatencyMs |
  Format-Table -AutoSize
```

Voir les identites :

```powershell
Invoke-RestMethod "$Api/user-runtime" | ConvertTo-Json -Depth 8
```

Voir les services :

```powershell
Invoke-RestMethod "$Api/services" | ConvertTo-Json -Depth 8
```

Voir les workers mock :

```powershell
Invoke-RestMethod "$Api/workers" | ConvertTo-Json -Depth 8
```

Voir les logs orchestrator mock :

```bash
ssh nodemaster
sudo kubectl -n ucnnct-mock logs deploy/orchestrator --tail=200
```

Voir les logs workers mock :

```bash
ssh nodemaster
sudo kubectl -n ucnnct-mock logs deploy/worker-service --tail=200
```

Voir les erreurs recentes staging :

```bash
ssh rayleigh
kubectl -n staging get events --sort-by=.lastTimestamp | tail -n 50
kubectl -n staging get pods | grep -v Running
```

## Procedure de recuperation

Si un run doit etre arrete :

```powershell
$Api = "http://172.31.255.240:88/api/v1/control-plane"
Invoke-RestMethod "$Api/runs/<run-id>/stop" -Method Post | ConvertTo-Json -Depth 8
```

Verifier ensuite :

```powershell
Invoke-RestMethod "$Api/user-runtime" | ConvertTo-Json -Depth 8
```

Attendre :

- `leasedUsers = 0`
- `activeLeases = 0`
- `availableUsers = 10000`

Si un rollout met du temps a redescendre :

```bash
ssh rayleigh
kubectl -n staging get hpa media-service chat-service notification-service group-service user-service -o wide
kubectl -n staging get rollout media-service chat-service notification-service group-service user-service \
  -o custom-columns=NAME:.metadata.name,PHASE:.status.phase,READY:.status.readyReplicas,REPLICAS:.status.replicas
```

Attendre que les rollouts reviennent en `Healthy` avant d'enchainer un autre scenario.

## Checklist courte avant presentation

```text
[ ] Front accessible sur http://172.31.255.240:88/
[ ] Argo uconnect-staging Synced / Healthy
[ ] Argo ucnnct-mock-staging Synced / Healthy
[ ] orchestrator mock en 0.14.1
[ ] user-runtime: 10000 disponibles, 0 lease actif
[ ] ws-manager: 45 ready
[ ] media-service: VPA Recreate, minReplicas 2
[ ] services metier principaux Healthy
[ ] terminal HPA ouvert
[ ] terminal rollout ouvert
[ ] terminal pods media/group ouvert
```

## Script oral resume

```text
Je lance d'abord un profil media. Tous les virtual users se connectent avec de
vraies identites staging, ouvrent un websocket et font de vrais appels vers
staging.uconnect.cc. Comme le poids groupe est a zero, group-service ne doit pas
monter. En revanche media-service, chat-service et notification-service peuvent
reagir. Le panel Scaling montre les HPA reels et le VPA de media-service.

Ensuite je lance le profil inverse. Media vaut zero, groupe est dominant. Cette
fois media-service reste stable, group-service monte, chat-service monte aussi
car il porte l'insertion des messages, et notification-service reagit au fan-out.

La demonstration montre donc deux axes : horizontal scaling par nombre de pods,
et vertical scaling par recommandations/mutations de ressources sur un service
precis.
```
