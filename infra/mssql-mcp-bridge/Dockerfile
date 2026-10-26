FROM mcr.microsoft.com/azure-databases/data-api-builder:latest

WORKDIR /App
COPY dab-config.json /App/dab-config.json

ENV ASPNETCORE_URLS=http://+:5000
EXPOSE 5000

ENTRYPOINT ["dotnet", "Azure.DataApiBuilder.Service.dll", "--ConfigFileName", "/App/dab-config.json"]
