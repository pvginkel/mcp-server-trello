import org.jenkinsci.plugins.pipeline.modeldefinition.Utils

library identifier: 'JenkinsPipelineUtils', changelog: false

podTemplate(inheritFrom: 'jenkins-agent kaniko') {
    node(POD_LABEL) {
        stage('Cloning repo') {
            checkout scm
        }

        stage('Building trello-mcp') {
            container('kaniko') {
                helmCharts.kaniko([
                    "registry:5000/trello-mcp:${currentBuild.number}",
                    "registry:5000/trello-mcp:latest"
                ])
            }
        }

        stage('Deploy Helm charts') {
            cicd.helmDeploy()
        }
    }
}
