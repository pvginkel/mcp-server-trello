// Builds the trello-mcp image and pins it into TrelloMcpDeploy, which Argo CD syncs to prd.
//
// Controller config:
//   - Job: TrelloMcp
//   - SCM: pvginkel/mcp-server-trello, branch test
//   - Script Path: Jenkinsfile

library identifier: 'JenkinsPipelineUtils', changelog: false

pipeline {
    agent {
        kubernetes {
            inheritFrom 'jenkins-agent kaniko'
            yamlMergeStrategy merge()
            yaml podYaml(templates: ['k8s'])
        }
    }

    options {
        disableConcurrentBuilds(abortPrevious: true)
        skipDefaultCheckout()
        timeout(time: 60, unit: 'MINUTES')
        timestamps()
    }

    triggers {
        githubPush()
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Build trello-mcp image') {
            steps {
                container('kaniko') {
                    script {
                        helmCharts.kaniko2(destinations: [
                            "registry:5000/trello-mcp:${currentBuild.number}",
                            'registry:5000/trello-mcp:latest',
                        ])
                    }
                }
            }
        }

        stage('Write image pins') {
            steps {
                container('k8s') {
                    script {
                        cicd.writeVersionPins(repo: 'pvginkel/TrelloMcpDeploy', pins: [
                            'config/prd/values.yaml': ['images.trello_mcp': ":${currentBuild.number}"],
                        ])
                    }
                }
            }
        }
    }
}
