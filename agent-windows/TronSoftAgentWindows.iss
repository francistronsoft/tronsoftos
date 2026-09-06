#define MyAppName "TronSoft Agent Windows"
#define MyAppVersion "0.1.7.0"
#define MyAppPublisher "TronSoft"
#define MyServiceName "TronSoftAgentWindows"
#define MyAppExeName "TronSoft.Agent.Windows.exe"

[Setup]
AppId={{B8FBC6F8-0B55-4C7B-8F9A-1BB7275A5A19}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={sd}\TronSoft\AgentWindows
DefaultGroupName=TronSoft
DisableProgramGroupPage=yes
OutputDir=installer-output
OutputBaseFilename=TronSoftAgentWindowsSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}
CloseApplications=yes
CloseApplicationsFilter={#MyAppExeName}
RestartApplications=no

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Files]
Source: "installer-win-x64\TronSoft.Agent.Windows.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "installer-win-x64\e_sqlite3.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "installer-win-x64\appsettings.json"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{app}\config"
Name: "{app}\data"
Name: "{app}\logs"
Name: "{app}\cache"

[Icons]
Name: "{group}\TronSoft Agent Windows"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Desinstalar TronSoft Agent Windows"; Filename: "{uninstallexe}"

[UninstallRun]
Filename: "sc.exe"; Parameters: "stop {#MyServiceName}"; Flags: runhidden waituntilterminated; RunOnceId: "StopService"
Filename: "sc.exe"; Parameters: "delete {#MyServiceName}"; Flags: runhidden waituntilterminated; RunOnceId: "DeleteService"

[Code]
var
  ConfigPage: TInputQueryWizardPage;
  FirebirdPage: TInputQueryWizardPage;
  BackupPage: TInputDirWizardPage;
  BackupOptionsPage: TInputQueryWizardPage;

function JsonEscape(Value: string): string;
begin
  Result := Value;
  StringChangeEx(Result, '\', '\\', True);
  StringChangeEx(Result, '"', '\"', True);
  StringChangeEx(Result, #13#10, '\n', True);
  StringChangeEx(Result, #10, '\n', True);
  StringChangeEx(Result, #13, '\n', True);
end;

function Quote(Value: string): string;
begin
  Result := '"' + Value + '"';
end;

function BackupMaxAgeHours: string;
var
  Value: Integer;
begin
  if StrToIntDef(Trim(BackupOptionsPage.Values[0]), 0) <= 0 then
  begin
    Result := '24';
  end
  else
  begin
    Value := StrToIntDef(Trim(BackupOptionsPage.Values[0]), 24);
    Result := IntToStr(Value);
  end;
end;

function DefaultBackupDirectory: string;
begin
  if DirExists('D:\TronSoft') then
  begin
    Result := 'D:\TronSoft\Backup';
  end
  else
  begin
    Result := 'C:\TronSoft\Backup';
  end;
end;

procedure InitializeWizard;
begin
  ConfigPage := CreateInputQueryPage(
    wpSelectDir,
    'Configuracao da Central',
    'Informe os dados de pareamento do cliente.',
    'O token deve ser gerado no cadastro do cliente na Central TronSoftOS.'
  );
  ConfigPage.Add('URL da Central:', False);
  ConfigPage.Add('Token de pareamento:', False);
  ConfigPage.Add('Nome do ambiente:', False);
  ConfigPage.Add('Alias do servidor:', False);
  ConfigPage.Values[0] := 'https://central.tronsoft.app.br';
  ConfigPage.Values[2] := 'Servidor Windows';
  ConfigPage.Values[3] := 'SERVIDOR';

  FirebirdPage := CreateInputQueryPage(
    ConfigPage.ID,
    'Monitoramento local',
    'Informe os dados usados para consultar o Firebird.',
    'Esses dados podem ser ajustados depois em C:\TronSoft\AgentWindows\config\agent.json.'
  );
  FirebirdPage.Add('Caminho do banco Firebird:', False);
  FirebirdPage.Add('Alias do banco:', False);
  FirebirdPage.Add('Host Firebird:', False);
  FirebirdPage.Add('Usuario Firebird:', False);
  FirebirdPage.Add('Senha Firebird:', True);
  FirebirdPage.Add('Caminho do isql.exe (opcional):', False);
  FirebirdPage.Values[0] := 'C:\ERP_TRONSOFT\ERP_TRONSOFT.FDB';
  FirebirdPage.Values[1] := 'erp_tronsoft';
  FirebirdPage.Values[2] := 'localhost';
  FirebirdPage.Values[3] := 'SYSDBA';
  FirebirdPage.Values[4] := 'masterkey';

  BackupPage := CreateInputDirPage(
    FirebirdPage.ID,
    'Monitoramento de backup',
    'Selecione a pasta onde os backups locais sao gravados.',
    'A Central usara essa informacao para avaliar se o backup esta recente.',
    False,
    ''
  );
  BackupPage.Add('Pasta de backup:');
  BackupPage.Values[0] := DefaultBackupDirectory;

  BackupOptionsPage := CreateInputQueryPage(
    BackupPage.ID,
    'Regra de backup',
    'Informe quando a Central deve considerar o backup atrasado.',
    'Use um valor compativel com a rotina de backup do cliente.'
  );
  BackupOptionsPage.Add('Idade maxima sem backup (horas):', False);
  BackupOptionsPage.Values[0] := '24';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;

  if CurPageID = ConfigPage.ID then
  begin
    if Trim(ConfigPage.Values[0]) = '' then
    begin
      MsgBox('Informe a URL da Central.', mbError, MB_OK);
      Result := False;
    end
    else if Trim(ConfigPage.Values[1]) = '' then
    begin
      MsgBox('Informe o token de pareamento gerado na Central.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function IsAgentProcessRunning: Boolean;
var
  ResultCode: Integer;
begin
  Exec(
    ExpandConstant('{cmd}'),
    '/C tasklist /FI "IMAGENAME eq {#MyAppExeName}" | find /I "{#MyAppExeName}" >NUL',
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  );
  Result := ResultCode = 0;
end;

function PrepareToInstall(var NeedsRestart: Boolean): string;
var
  ResultCode: Integer;
  Attempt: Integer;
begin
  Result := '';
  NeedsRestart := False;

  Exec('sc.exe', 'stop {#MyServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  for Attempt := 1 to 10 do
  begin
    if not IsAgentProcessRunning then
    begin
      Exit;
    end;
    Sleep(1000);
  end;

  Exec('taskkill.exe', '/IM ' + Quote('{#MyAppExeName}') + ' /T /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(1000);

  if IsAgentProcessRunning then
  begin
    Result :=
      'O TronSoft Agent Windows ainda esta em execucao e nao foi possivel finalizar automaticamente.' + #13#10 +
      'Feche o agente pelo Gerenciador de Tarefas ou reinicie o Windows e tente instalar novamente.';
  end;
end;

procedure WriteAgentConfig;
var
  ConfigDir: string;
  ConfigPath: string;
  Json: string;
begin
  ConfigDir := ExpandConstant('{app}\config');
  ConfigPath := ConfigDir + '\agent.json';
  ForceDirectories(ConfigDir);

  Json :=
    '{' + #13#10 +
    '  "Agent": {' + #13#10 +
    '    "CentralUrl": "' + JsonEscape(Trim(ConfigPage.Values[0])) + '",' + #13#10 +
    '    "PairingToken": "' + JsonEscape(Trim(ConfigPage.Values[1])) + '",' + #13#10 +
    '    "InstallationId": "",' + #13#10 +
    '    "EnvironmentName": "' + JsonEscape(Trim(ConfigPage.Values[2])) + '",' + #13#10 +
    '    "ServerAlias": "' + JsonEscape(Trim(ConfigPage.Values[3])) + '",' + #13#10 +
    '    "HeartbeatIntervalSeconds": 60,' + #13#10 +
    '    "Firebird": {' + #13#10 +
    '      "Enabled": true,' + #13#10 +
    '      "DatabasePath": "' + JsonEscape(Trim(FirebirdPage.Values[0])) + '",' + #13#10 +
    '      "Alias": "' + JsonEscape(Trim(FirebirdPage.Values[1])) + '",' + #13#10 +
    '      "Host": "' + JsonEscape(Trim(FirebirdPage.Values[2])) + '",' + #13#10 +
    '      "User": "' + JsonEscape(Trim(FirebirdPage.Values[3])) + '",' + #13#10 +
    '      "Password": "' + JsonEscape(Trim(FirebirdPage.Values[4])) + '",' + #13#10 +
    '      "IsqlPath": "' + JsonEscape(Trim(FirebirdPage.Values[5])) + '",' + #13#10 +
    '      "QueryTimeoutSeconds": 20' + #13#10 +
    '    },' + #13#10 +
    '    "Backups": {' + #13#10 +
    '      "Directory": "' + JsonEscape(Trim(BackupPage.Values[0])) + '",' + #13#10 +
    '      "MaxAgeHours": ' + BackupMaxAgeHours + #13#10 +
    '    }' + #13#10 +
    '  }' + #13#10 +
    '}' + #13#10;

  SaveStringToFile(ConfigPath, Json, False);
end;

procedure InstallService;
var
  ResultCode: Integer;
  ExePath: string;
begin
  ExePath := ExpandConstant('{app}\{#MyAppExeName}');

  Exec('sc.exe', 'stop {#MyServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('sc.exe', 'delete {#MyServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  Exec(
    'sc.exe',
    'create {#MyServiceName} binPath= ' + Quote(ExePath) + ' start= auto DisplayName= "TronSoft Agent Windows"',
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  );

  if ResultCode <> 0 then
  begin
    MsgBox('Nao foi possivel criar o servico Windows. Codigo: ' + IntToStr(ResultCode), mbError, MB_OK);
    Exit;
  end;

  Exec('sc.exe', 'description {#MyServiceName} "Monitora servidor Windows e envia dados para a Central TronSoftOS."', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('sc.exe', 'failure {#MyServiceName} reset= 86400 actions= restart/60000/restart/60000/restart/60000', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('sc.exe', 'start {#MyServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    WriteAgentConfig;
    InstallService;
  end;
end;
